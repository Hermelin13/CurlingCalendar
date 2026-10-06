#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import unicodedata
from datetime import datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = ROOT / "config" / "sources.json"
DATA_FILE = ROOT / "data" / "events.json"

TEAM = "CB BUTchers"

DATE_RE = re.compile(
    r"(?<!\\d)(?P<date>\\d{1,2}\\.\\s*\\d{1,2}\\.\\s*\\d{4})(?!\\d)",
    re.I,
)



def compact(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def norm_name(value: str | None) -> str:
    text = compact(value).casefold()
    text = "".join(
        ch for ch in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(ch)
    )
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return compact(text)


def clean_team_label(value: str) -> tuple[str, bool]:
    raw = compact(value)
    # Na vysledky.curling.cz je * u týmu s výhodou posledního kamene.
    has_star = "*" in raw or "★" in raw
    cleaned = re.sub(r"[●○◉•*★☆]+", " ", raw)
    return compact(cleaned), has_star


def parse_float(value: str | None) -> float | None:
    text = compact(value).replace(",", ".")
    if not text or text.upper() == "X":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_score(value: str | None) -> int | None:
    text = compact(value)
    if not re.fullmatch(r"\d{1,2}", text):
        return None
    return int(text)


def nearest_match_date(table) -> str | None:
    """
    Najde nejbližší datum před výsledkovou tabulkou.

    Čas ani dráha se nepoužívají. Na výsledkovém webu jsou datum,
    čas a dráha často rozdělené do více HTML elementů, takže není
    spolehlivé vyžadovat je v jednom textu.
    """
    for node in table.find_all_previous(string=True, limit=500):
        text = compact(str(node))
        if not text or len(text) > 250:
            continue

        match = DATE_RE.search(text)
        if not match:
            continue

        parsed = datetime.strptime(
            re.sub(r"\s+", "", match.group("date")),
            "%d.%m.%Y",
        )
        return parsed.strftime("%Y-%m-%d")

    return None

def parse_official_page(html: str, team_name: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    wanted = norm_name(team_name)
    matches: list[dict] = []

    tables = soup.find_all("table")
    print(f"Oficiální výsledky: nalezeno {len(tables)} HTML tabulek")

    for table in tables:
        rows = table.find_all("tr")
        if len(rows) < 3:
            continue

        header_index = None
        headers = None

        for i, tr in enumerate(rows[:4]):
            cells = tr.find_all(["th", "td"])
            values = [compact(c.get_text(" ", strip=True)).upper() for c in cells]
            if "TOTAL" in values and "LSD1" in values and "LSD2" in values:
                header_index = i
                headers = values
                break

        if headers is None:
            continue

        try:
            total_i = headers.index("TOTAL")
            lsd1_i = headers.index("LSD1")
            lsd2_i = headers.index("LSD2")
        except ValueError:
            continue

        team_rows = []
        for tr in rows[header_index + 1:]:
            cells = tr.find_all(["th", "td"])
            if len(cells) <= max(total_i, lsd1_i, lsd2_i):
                continue

            raw_team = compact(cells[0].get_text(" ", strip=True))
            team, has_star = clean_team_label(raw_team)
            score = parse_score(cells[total_i].get_text(" ", strip=True))
            lsd1 = parse_float(cells[lsd1_i].get_text(" ", strip=True))
            lsd2 = parse_float(cells[lsd2_i].get_text(" ", strip=True))

            if not team or score is None:
                continue

            team_rows.append({
                "team": team,
                "score": score,
                "lsd1": lsd1,
                "lsd2": lsd2,
                "hasStar": has_star,
            })

        if len(team_rows) < 2:
            continue

        our = next((r for r in team_rows if norm_name(r["team"]) == wanted), None)
        if not our:
            continue

        opponent = next((r for r in team_rows if r is not our), None)
        if not opponent:
            continue

        date_str = nearest_match_date(table)
        if not date_str:
            print(f"VAROVÁNÍ: neumím zjistit datum u zápasu vs {opponent['team']}")
            continue

        # Nejdřív použijeme značku * přímo z výsledkové stránky.
        # Kdyby ji HTML někdy přestalo obsahovat jako text, fallback je součet LSD:
        # nižší součet LSD získává výhodu posledního kamene v prvním endu.
        lsd_advantage = None
        if our["hasStar"] and not opponent["hasStar"]:
            lsd_advantage = True
        elif opponent["hasStar"] and not our["hasStar"]:
            lsd_advantage = False
        elif all(v is not None for v in (
            our["lsd1"], our["lsd2"], opponent["lsd1"], opponent["lsd2"]
        )):
            our_lsd = our["lsd1"] + our["lsd2"]
            opp_lsd = opponent["lsd1"] + opponent["lsd2"]
            if our_lsd != opp_lsd:
                lsd_advantage = our_lsd < opp_lsd

        matches.append({
            "date": date_str,
            "team": our["team"],
            "opponent": opponent["team"],
            "ourScore": our["score"],
            "opponentScore": opponent["score"],
            "lsdAdvantage": lsd_advantage,
            "ourLsd1": our["lsd1"],
            "ourLsd2": our["lsd2"],
            "opponentLsd1": opponent["lsd1"],
            "opponentLsd2": opponent["lsd2"],
        })

    return matches


def match_event_id(result: dict, events: list[dict]) -> str | None:
    """
    Párování výsledku s kalendářem:
    - stejné datum
    - stejný soupeř

    Čas ani dráha nejsou podmínkou.
    """
    candidates = [
        e for e in events
        if (e.get("type") == "match" or e.get("opponent"))
        and e.get("date") == result["date"]
    ]

    if not candidates:
        return None

    exact = [
        e for e in candidates
        if norm_name(e.get("opponent")) == norm_name(result["opponent"])
    ]
    if len(exact) == 1:
        return exact[0]["id"]

    # Fallback pro lehce odlišné názvy týmů mezi zdroji.
    wanted = norm_name(result["opponent"])
    fuzzy = []
    for e in candidates:
        opponent = norm_name(e.get("opponent"))
        if opponent and wanted and (opponent in wanted or wanted in opponent):
            fuzzy.append(e)

    if len(fuzzy) == 1:
        return fuzzy[0]["id"]

    # Pokud je v daný den v našem kalendáři jen jeden zápas,
    # je bezpečnější vzít ho než blokovat import kvůli názvu soupeře.
    if len(candidates) == 1:
        return candidates[0]["id"]

    return None

def main() -> None:
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    result_cfg = cfg.get("officialResults") or {}

    url = compact(result_cfg.get("url"))
    team_name = compact(result_cfg.get("team")) or TEAM
    if not url:
        raise RuntimeError("V config/sources.json chybí officialResults.url")

    response = requests.get(
        url,
        timeout=45,
        allow_redirects=True,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (compatible; CB-BUTchers-calendar/1.0; "
                "+https://curlingcalendar.adamdaliborj.workers.dev/)"
            ),
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    response.raise_for_status()

    official = parse_official_page(response.text, team_name)
    print(f"Oficiální výsledky: {len(official)} zápasů týmu {team_name}")

    events = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    payload = []

    for result in official:
        event_id = match_event_id(result, events)
        if not event_id:
            print(
                "VAROVÁNÍ: nenašel jsem událost v kalendáři pro "
                f"{result['date']} vs {result['opponent']}"
            )
            continue

        payload.append({
            "eventId": event_id,
            **result,
            "sourceUrl": url,
        })

    print(f"Oficiální výsledky: {len(payload)} zápasů spárováno s D1 událostmi")

    if not payload:
        print("Není co importovat.")
        return

    api_base = compact(os.getenv("API_BASE")).rstrip("/")
    import_token = compact(os.getenv("IMPORT_TOKEN"))
    if not api_base or not import_token:
        raise RuntimeError("Chybí API_BASE nebo IMPORT_TOKEN.")

    res = requests.post(
        f"{api_base}/api/import-results",
        headers={
            "Authorization": f"Bearer {import_token}",
            "Content-Type": "application/json",
        },
        json={"results": payload},
        timeout=45,
    )

    if not res.ok:
        raise RuntimeError(
            f"Import výsledků selhal HTTP {res.status_code}: {res.text[:1000]}"
        )

    print("D1 import:", res.text)


if __name__ == "__main__":
    main()
