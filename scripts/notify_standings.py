#!/usr/bin/env python3
from __future__ import annotations

import csv
import io
import json
import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = ROOT / "config" / "sources.json"
STATE_FILE = ROOT / "data" / "discord_standings_state.json"
TEAM = "CB Butchers"
DIVISION_STANDINGS_URL = (
    "https://vysledky.curling.cz/standings/default?seasonId=6&leagueId=351"
)


def compact(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def norm(value: str | None) -> str:
    text = compact(value).casefold()
    text = "".join(
        ch for ch in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(ch)
    )
    return re.sub(r"[^a-z0-9]+", "", text)


def parse_position(value: str | None) -> int | None:
    match = re.search(r"(?<!\d)(\d{1,2})(?:\.)?(?!\d)", compact(value))
    if not match:
        return None
    value = int(match.group(1))
    return value if 1 <= value <= 99 else None


def load_csv(urls: list[str]) -> list[list[str]]:
    last_error = None
    for url in urls:
        if not url:
            continue
        try:
            response = requests.get(url, timeout=45, allow_redirects=True)
            response.raise_for_status()
            text = response.content.decode("utf-8-sig")
            content_type = (response.headers.get("content-type") or "").lower()
            if "text/html" in content_type or "<html" in text[:500].lower():
                raise RuntimeError("Google místo CSV vrátil HTML.")
            rows = list(csv.reader(io.StringIO(text)))
            if rows:
                return rows
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"Google tabulku se nepodařilo načíst: {last_error}")


def google_position(cfg: dict, team_name: str) -> int | None:
    rows = load_csv([
        compact(cfg.get("csvUrl")),
        compact(cfg.get("fallbackCsvUrl")),
    ])
    wanted = norm(team_name)

    # Brněnský pohár má tabulky v G:L a M:R. Typicky je pořadí v G/M
    # a název týmu v H/N.
    for rank_col, team_col in ((6, 7), (12, 13)):
        for row in rows:
            if team_col >= len(row) or norm(row[team_col]) != wanted:
                continue
            position = parse_position(row[rank_col] if rank_col < len(row) else "")
            if position:
                return position

    # Fallback pro drobnou změnu layoutu: najdeme tým a hledáme pořadí vlevo.
    for row in rows:
        for i, cell in enumerate(row):
            if norm(cell) != wanted:
                continue
            for j in range(max(0, i - 2), i):
                position = parse_position(row[j])
                if position:
                    return position
    return None


def division_position(url: str, team_name: str) -> int | None:
    response = requests.get(
        url,
        timeout=45,
        allow_redirects=True,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (compatible; CB-Butchers-calendar/1.0; "
                "+https://curlingcalendar.adamdaliborj.workers.dev/)"
            ),
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    wanted = norm(team_name)

    for tr in soup.find_all("tr"):
        cells = [compact(c.get_text(" ", strip=True)) for c in tr.find_all(["th", "td"])]
        if len(cells) < 2:
            continue

        team_index = next(
            (
                i for i, value in enumerate(cells)
                if norm(value) == wanted or (wanted and wanted in norm(value))
            ),
            None,
        )
        if team_index is None:
            continue

        # Pořadí je v tabulce před názvem týmu; preferujeme první buňky řádku.
        for value in cells[: max(1, team_index + 1)]:
            position = parse_position(value)
            if position:
                return position

    return None


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {"initialized": False, "standings": {}}
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("state není objekt")
        data.setdefault("initialized", False)
        data.setdefault("standings", {})
        return data
    except Exception as exc:
        print(f"VAROVÁNÍ: stav pořadí nejde načíst ({exc}); vytvářím nový baseline.")
        return {"initialized": False, "standings": {}}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def send_change(webhook_urls: list[str], competition: str, old: int, new: int) -> bool:
    webhook_urls = [url for url in dict.fromkeys(webhook_urls) if url]
    if not webhook_urls:
        print("VAROVÁNÍ: není nastaven žádný Discord webhook; změnu zatím neukládám.")
        return False

    arrow = "⬆️" if new < old else "⬇️"
    message = "\n".join([
        "📊 **ZMĚNA POŘADÍ – CB Butchers**",
        "",
        f"🏆 {competition}",
        "",
        f"**{old}. → {new}. místo {arrow}**",
    ])

    sent = 0
    for index, webhook_url in enumerate(webhook_urls, start=1):
        try:
            response = requests.post(
                webhook_url,
                json={"content": message, "allowed_mentions": {"parse": []}},
                timeout=30,
            )
            response.raise_for_status()
            sent += 1
        except Exception as exc:
            # Jeden nefunkční server nesmí zablokovat doručení na druhý.
            print(f"VAROVÁNÍ: Discord webhook #{index} pro pořadí selhal: {exc}")

    if sent:
        print(
            f"Discord pořadí: {competition}: {old}. → {new}. "
            f"Odesláno na {sent} webhook(y)."
        )
        return True

    return False

def main() -> None:
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    team_name = compact((cfg.get("officialResults") or {}).get("team")) or TEAM
    webhook_urls = [
        compact(os.getenv("DISCORD_WEBHOOK_URL")),
        compact(os.getenv("DISCORD_WEBHOOK_URL_B")),
    ]

    current: dict[str, int] = {}

    google_cfg = cfg.get("googleSheet") or {}
    cup_name = compact(google_cfg.get("competition")) or "Brněnský pohár"
    try:
        position = google_position(google_cfg, team_name)
        if position is not None:
            current[cup_name] = position
            print(f"Pořadí: {cup_name}: {position}.")
        else:
            print(f"VAROVÁNÍ: {cup_name}: CB Butchers v tabulce nenalezen.")
    except Exception as exc:
        print(f"VAROVÁNÍ: {cup_name}: pořadí se nepodařilo načíst: {exc}")

    pdf_cfg = cfg.get("pdf") or {}
    division_name = compact(pdf_cfg.get("competition")) or "MČR mužů a žen – divize"
    division_url = compact(os.getenv("DIVISION_STANDINGS_URL")) or DIVISION_STANDINGS_URL
    try:
        position = division_position(division_url, team_name)
        if position is not None:
            current[division_name] = position
            print(f"Pořadí: {division_name}: {position}.")
        else:
            print(f"VAROVÁNÍ: {division_name}: CB Butchers v tabulce nenalezen.")
    except Exception as exc:
        print(f"VAROVÁNÍ: {division_name}: pořadí se nepodařilo načíst: {exc}")

    if not current:
        print("Pořadí: žádný zdroj se nepodařilo načíst; stav neměním.")
        return

    state = load_state()
    standings = state.setdefault("standings", {})

    # První běh vytvoří baseline a nic neposílá.
    if not state.get("initialized"):
        standings.update(current)
        state["initialized"] = True
        save_state(state)
        print("Pořadí: uložen výchozí stav; Discord se při prvním běhu neposílá.")
        return

    changed_state = False

    for competition, new_position in current.items():
        previous_raw = standings.get(competition)
        try:
            old_position = int(previous_raw) if previous_raw is not None else None
        except (TypeError, ValueError):
            old_position = None

        if old_position is None:
            # Nově objevená soutěž dostane baseline bez notifikace.
            standings[competition] = new_position
            changed_state = True
            continue

        if old_position == new_position:
            continue

        if send_change(webhook_urls, competition, old_position, new_position):
            standings[competition] = new_position
            changed_state = True

    if changed_state:
        save_state(state)
    else:
        print("Pořadí: beze změny.")


if __name__ == "__main__":
    main()
