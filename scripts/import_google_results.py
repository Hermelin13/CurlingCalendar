#!/usr/bin/env python3
from __future__ import annotations

import csv
import io
import json
import os
import re
from datetime import date
from pathlib import Path

import requests
from dateutil import parser as date_parser

ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = ROOT / "config" / "sources.json"
DATA_FILE = ROOT / "data" / "events.json"

TEAM = "CB BUTchers"


def compact(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def norm(value: str | None) -> str:
    return compact(value).casefold()


def parse_date_value(value: str):
    text = compact(value)
    if not text:
        return None

    m = re.search(r"(?<!\d)(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{4})(?!\d)", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None

    m = re.search(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None

    try:
        return date_parser.parse(text, dayfirst=True, fuzzy=True).date()
    except Exception:
        return None


def parse_score(value: str | None) -> int | None:
    text = compact(value).replace(",", ".")
    if not text:
        return None

    # Google CSV může číslo vrátit jako "7" nebo "7.0".
    if not re.fullmatch(r"\d{1,2}(?:\.0+)?", text):
        return None

    score = int(float(text))
    return score if 0 <= score <= 99 else None


def load_google_rows(cfg: dict) -> tuple[list[list[str]], str]:
    urls = [cfg.get("csvUrl"), cfg.get("fallbackCsvUrl")]
    urls = [u for u in urls if u]
    last_error = None

    for url in urls:
        try:
            response = requests.get(url, timeout=45, allow_redirects=True)
            response.raise_for_status()

            content_type = (response.headers.get("content-type") or "").lower()

            # Google CSV je UTF-8. Nenecháváme requests hádat encoding.
            text = response.content.decode("utf-8-sig")

            if "text/html" in content_type or "<html" in text[:500].lower():
                raise RuntimeError(
                    "Google místo CSV vrátil HTML. Dokument nejspíš "
                    "není dostupný bez přihlášení."
                )

            rows = list(csv.reader(io.StringIO(text)))
            if rows:
                return rows, url
        except Exception as exc:
            last_error = exc

    raise RuntimeError(f"Google Sheet se nepodařilo načíst: {last_error}")


def parse_google_results(cfg: dict) -> list[dict]:
    rows, used_url = load_google_rows(cfg)

    def cell(r: int, c: int) -> str:
        if r < 0 or r >= len(rows):
            return ""
        if c < 0 or c >= len(rows[r]):
            return ""
        return compact(str(rows[r][c] or ""))

    def date_from_header_row(r: int):
        if r < 0 or r >= len(rows):
            return None
        for value in rows[r]:
            parsed = parse_date_value(str(value or ""))
            if parsed:
                return parsed
        return None

    time_re = re.compile(
        r"^\s*(?:dráha\s*)?([A-ZÁ-Ž]|\d+)\s*[-–—]\s*"
        r"(\d{1,2})[:.](\d{2})\s*$",
        re.I,
    )

    # Stejně jako kalendář: hledáme jen skutečné sloupce rozpisu s časem.
    time_columns = set()
    for r, row in enumerate(rows):
        for c, value in enumerate(row):
            if time_re.match(compact(str(value or ""))):
                time_columns.add(c)

    if not time_columns:
        raise RuntimeError(
            "Nenašel jsem žádný sloupec s časy zápasů "
            "(např. 'A - 18:00')."
        )

    # Ve skutečném rozpisu jsou sloupce:
    # Čas | Tým | Body | Endy | Kameny
    # Ověříme, že u každého časového sloupce je opravdu jeho Kameny.
    score_columns: dict[int, int] = {}
    for time_col in sorted(time_columns):
        expected = time_col + 4
        found = False

        # Nad prvním blokem je hlavička "Kameny".
        for r in range(min(10, len(rows))):
            if norm(cell(r, expected)) == norm("Kameny"):
                found = True
                break

        if not found:
            raise RuntimeError(
                f"U sloupce s časem {time_col + 1} jsem nenašel "
                f"o 4 sloupce vpravo hlavičku 'Kameny'. "
                "Výsledky raději neimportuji."
            )

        score_columns[time_col] = expected

    current_dates = {c: None for c in time_columns}
    results = []
    seen = set()

    for r in range(len(rows)):
        for time_col in sorted(time_columns):
            value = cell(r, time_col)

            if norm(value) == norm("Dráha - Čas"):
                parsed = date_from_header_row(r)
                if parsed:
                    current_dates[time_col] = parsed
                continue

            match = time_re.match(value)
            if not match:
                continue

            team_col = time_col + 1
            score_col = score_columns[time_col]

            team1 = cell(r, team_col)
            team2 = cell(r + 1, team_col)

            if norm(team1) != norm(TEAM) and norm(team2) != norm(TEAM):
                continue

            score1 = parse_score(cell(r, score_col))
            score2 = parse_score(cell(r + 1, score_col))

            # Dokud nejsou vyplněny oba výsledky, zápas není hotový.
            if score1 is None or score2 is None:
                continue

            match_date = current_dates.get(time_col)
            if not match_date:
                for rr in range(r, max(-1, r - 30), -1):
                    if norm(cell(rr, time_col)) == norm("Dráha - Čas"):
                        match_date = date_from_header_row(rr)
                        if match_date:
                            current_dates[time_col] = match_date
                            break

            if not match_date:
                print(
                    f"VAROVÁNÍ: výsledek na řádku {r + 1} nemá datum, "
                    "přeskakuji."
                )
                continue

            opponent = team2 if norm(team1) == norm(TEAM) else team1
            our_score = score1 if norm(team1) == norm(TEAM) else score2
            opponent_score = score2 if norm(team1) == norm(TEAM) else score1

            date_str = match_date.isoformat()
            key = (date_str, norm(opponent))
            if key in seen:
                continue
            seen.add(key)

            results.append({
                "date": date_str,
                "opponent": opponent,
                "ourScore": our_score,
                "opponentScore": opponent_score,
            })

    print(f"Google výsledky: nalezeno {len(results)} dohraných zápasů {TEAM}")
    return results


def find_event_id(result: dict, events: list[dict]) -> str | None:
    candidates = [
        e for e in events
        if e.get("source", {}).get("type") == "excel"
        and e.get("date") == result["date"]
        and norm(e.get("opponent")) == norm(result["opponent"])
    ]

    if len(candidates) == 1:
        return candidates[0]["id"]

    if len(candidates) > 1:
        print(
            f"VAROVÁNÍ: více eventů pro {result['date']} "
            f"vs {result['opponent']}, nepáruji."
        )
    else:
        print(
            f"VAROVÁNÍ: event nenalezen pro {result['date']} "
            f"vs {result['opponent']}."
        )
    return None


def load_current_results(api_base: str) -> dict[str, tuple[int, int]]:
    """Vrátí aktuální skóre z D1 podle event_id."""
    response = requests.get(
        f"{api_base}/api/events",
        timeout=45,
    )
    response.raise_for_status()

    body = response.json()
    events = body.get("events") if isinstance(body, dict) else None
    if not isinstance(events, list):
        raise RuntimeError("API /api/events vrátilo nečekaný formát.")

    current: dict[str, tuple[int, int]] = {}
    for event in events:
        result = event.get("result") or {}
        if (
            result.get("ourScore") is not None
            and result.get("opponentScore") is not None
        ):
            current[str(event.get("id"))] = (
                int(result["ourScore"]),
                int(result["opponentScore"]),
            )
    return current


def send_discord(webhook_url: str, changed: list[dict], source_name: str) -> None:
    if not webhook_url or not changed:
        return

    lines = [f"🥌 **CB Butchers – nový výsledek ({source_name})**"]

    for item in changed:
        lines.append(
            f"**CB Butchers {item['ourScore']} : "
            f"{item['opponentScore']} {item['opponent']}**"
        )
        if item.get("date"):
            lines.append(f"📅 {item['date']}")

    message = "\n".join(lines)
    if len(message) > 1900:
        message = message[:1890] + "\n…"

    try:
        response = requests.post(
            webhook_url,
            json={
                "content": message,
                "allowed_mentions": {"parse": []},
            },
            timeout=30,
        )
        response.raise_for_status()
        print(f"Discord: odesláno upozornění pro {len(changed)} výsledek/ky.")
    except Exception as exc:
        # Výsledek už je bezpečně uložený v D1; chyba Discordu nesmí zrušit import.
        print(f"VAROVÁNÍ: Discord upozornění se nepodařilo odeslat: {exc}")


def main() -> None:
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    sheet_cfg = cfg.get("googleSheet") or {}

    results = parse_google_results(sheet_cfg)
    if not results:
        print("Google výsledky: zatím není co importovat.")
        return

    events = json.loads(DATA_FILE.read_text(encoding="utf-8"))

    spreadsheet_id = compact(sheet_cfg.get("spreadsheetId"))
    gid = sheet_cfg.get("gid")
    source_url = (
        f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit"
        + (f"?gid={gid}" if gid is not None else "")
        if spreadsheet_id
        else compact(sheet_cfg.get("csvUrl"))
    )

    payload = []
    for result in results:
        event_id = find_event_id(result, events)
        if not event_id:
            continue

        payload.append({
            "eventId": event_id,
            "ourScore": result["ourScore"],
            "opponentScore": result["opponentScore"],
            "resultSource": "google_sheet",
            "sourceUrl": source_url,
        })

    print(f"Google výsledky: {len(payload)} výsledků spárováno s eventy")

    if not payload:
        print("Google výsledky: není co odeslat do D1.")
        return

    api_base = compact(os.getenv("API_BASE")).rstrip("/")
    import_token = compact(os.getenv("IMPORT_TOKEN"))
    discord_webhook_url = compact(os.getenv("DISCORD_WEBHOOK_URL"))

    if not api_base or not import_token:
        raise RuntimeError("Chybí API_BASE nebo IMPORT_TOKEN.")

    current_results = load_current_results(api_base)
    changed = []
    result_by_event = {
        item["eventId"]: item
        for item in payload
    }

    for event_id, item in result_by_event.items():
        incoming = (item["ourScore"], item["opponentScore"])
        if current_results.get(event_id) != incoming:
            changed.append({
                **item,
                "opponent": next(
                    (
                        event.get("opponent")
                        for event in events
                        if event.get("id") == event_id
                    ),
                    "Soupeř",
                ),
                "date": next(
                    (
                        event.get("date")
                        for event in events
                        if event.get("id") == event_id
                    ),
                    None,
                ),
            })

    response = requests.post(
        f"{api_base}/api/import-results",
        headers={
            "Authorization": f"Bearer {import_token}",
            "Content-Type": "application/json",
        },
        json={"results": payload},
        timeout=45,
    )

    if not response.ok:
        raise RuntimeError(
            f"Import Google výsledků selhal HTTP "
            f"{response.status_code}: {response.text[:1000]}"
        )

    print("Google výsledky D1:", response.text)

    if changed:
        send_discord(
            discord_webhook_url,
            changed,
            "Brněnský pohár",
        )
    else:
        print("Discord: žádný nový ani změněný výsledek.")


if __name__ == "__main__":
    main()
