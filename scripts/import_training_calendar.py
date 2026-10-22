#!/usr/bin/env python3
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILE = ROOT / "config" / "sources.json"
TEAM = "CB BUTchers"

WEEKDAYS = {
    "monday": 0, "pondeli": 0,
    "tuesday": 1, "utery": 1,
    "wednesday": 2, "streda": 2,
    "thursday": 3, "ctvrtek": 3,
    "friday": 4, "patek": 4,
    "saturday": 5, "sobota": 5,
    "sunday": 6, "nedele": 6,
}

WEEKDAY_LABELS = {
    0: "pondělí",
    1: "úterý",
    2: "středa",
    3: "čtvrtek",
    4: "pátek",
    5: "sobota",
    6: "neděle",
}


def compact(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def ascii_norm(value) -> str:
    text = unicodedata.normalize("NFKD", compact(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.casefold()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def stable_id(*parts) -> str:
    raw = "|".join(compact(p) for p in parts)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
    return f"training-sheet-{digest}"


def parse_bool(value) -> bool:
    raw = compact(value)
    n = ascii_norm(raw)
    if not raw:
        return False
    if n in {"true", "ano", "yes", "x", "1", "checked", "check", "a"}:
        return True
    if raw in {"✓", "✔", "☑", "✅"}:
        return True
    try:
        return float(raw.replace(",", ".")) > 0
    except ValueError:
        return False


def parse_count(value) -> int | None:
    raw = compact(value).replace(",", ".")
    if not raw:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", raw)
    if not m:
        return None
    try:
        return int(float(m.group(0)))
    except ValueError:
        return None


def minutes(value: str) -> int:
    h, m = value.split(":")
    return int(h) * 60 + int(m)


def parse_time_range(value) -> tuple[str, str] | None:
    raw = compact(value)
    if not raw:
        return None

    # Google CSV: 7-8, 7:00–8:00, 07.30 - 08.30
    m = re.search(
        r"(?<!\d)(\d{1,2})(?:[:.](\d{1,2}))?\s*[-–—]\s*"
        r"(\d{1,2})(?:[:.](\d{1,2}))?(?!\d)",
        raw,
    )
    if m:
        h1, m1 = int(m.group(1)), int(m.group(2) or 0)
        h2, m2 = int(m.group(3)), int(m.group(4) or 0)
        if 0 <= h1 <= 23 and 0 <= h2 <= 23 and 0 <= m1 <= 59 and 0 <= m2 <= 59:
            start = f"{h1:02d}:{m1:02d}"
            end = f"{h2:02d}:{m2:02d}"
            if minutes(end) > minutes(start):
                return start, end

    # Pojistka pro XLSX/CSV, kde byly ranní buňky 7-8 / 8-9 / 9-10
    # technicky uložené jako Excel datum a jen naformátované jako d-m.
    try:
        serial = float(raw.replace(",", "."))
        if 1000 <= serial <= 100000 and serial.is_integer():
            d = (datetime(1899, 12, 30) + timedelta(days=int(serial))).date()
            h1, h2 = d.day, d.month
            if 0 <= h1 <= 23 and 1 <= h2 <= 23 and h2 > h1:
                return f"{h1:02d}:00", f"{h2:02d}:00"
    except ValueError:
        pass

    return None


def parse_weekday(value) -> int | None:
    n = ascii_norm(value)
    return WEEKDAYS.get(n)


def parse_iso_date(value: str | None, fallback: date) -> date:
    raw = compact(value)
    if not raw:
        return fallback
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise RuntimeError(f"Neplatné datum v konfiguraci: {raw}") from exc


def load_csv(cfg: dict) -> list[list[str]]:
    urls = [
        os.getenv("TRAINING_SHEET_CSV_URL", "").strip(),
        cfg.get("csvUrl"),
        cfg.get("fallbackCsvUrl"),
    ]
    urls = [compact(u) for u in urls if compact(u)]
    last_error = None

    for url in urls:
        try:
            r = requests.get(url, timeout=45, allow_redirects=True)
            r.raise_for_status()
            content_type = (r.headers.get("content-type") or "").lower()
            text = r.content.decode("utf-8-sig")
            if "text/html" in content_type or "<html" in text[:600].lower():
                raise RuntimeError(
                    "Google místo CSV vrátil HTML. Tabulka musí být dostupná "
                    "bez přihlášení (Kdokoli s odkazem – prohlížející)."
                )
            rows = list(csv.reader(io.StringIO(text)))
            if rows:
                print(f"Tréninkový kalendář: načteno {len(rows)} řádků")
                return rows
        except Exception as exc:
            last_error = exc

    raise RuntimeError(f"Tréninkový kalendář se nepodařilo načíst: {last_error}")


def load_users(api_base: str) -> list[dict]:
    r = requests.get(f"{api_base.rstrip('/')}/api/users", timeout=30)
    r.raise_for_status()
    body = r.json()
    users = body.get("users") if isinstance(body, dict) else None
    if not isinstance(users, list) or not users:
        raise RuntimeError("API /api/users nevrátilo aktivní uživatele.")
    return users


@dataclass
class WeeklySlot:
    weekday: int
    start: str
    end: str
    eliska: bool
    available_user_ids: set[str]


@dataclass
class WeeklyBlock:
    weekday: int
    start: str
    end: str
    eliska: bool
    slots: list[WeeklySlot]


@dataclass
class DatedBlock:
    date: str
    start: str
    end: str
    eliska: bool
    slots: list[WeeklySlot]


def find_header(rows: list[list[str]]) -> tuple[int, int, int]:
    for r, row in enumerate(rows):
        count_col = None
        eliska_training_col = None

        for c, value in enumerate(row):
            n = ascii_norm(value)

            if "trenink" in n and "3" in n:
                count_col = c

            # Důležité: chceme M = "Trenink s Eliškou", ne D = "Eliška".
            if "trenink" in n and "elisk" in n:
                eliska_training_col = c

        if count_col is not None and eliska_training_col is not None:
            return r, count_col, eliska_training_col

    raise RuntimeError(
        "Nenašel jsem hlavičku se sloupci 'Trenink 3+' a 'Trenink s Eliškou'. "
        "Nic se do kalendáře nezměnilo."
    )


def detect_columns(
    rows: list[list[str]],
    header_row: int,
    users: list[dict],
    count_col: int,
    eliska_training_col: int,
    cfg: dict,
):
    header = rows[header_row]
    aliases_cfg = cfg.get("userAliases") or {}

    # alias v Google tabulce -> jméno uživatele v aplikaci
    aliases = {
        ascii_norm(sheet_name): ascii_norm(app_name)
        for sheet_name, app_name in aliases_cfg.items()
        if compact(sheet_name) and compact(app_name)
    }

    users_by_name = {
        ascii_norm(user.get("name")): str(user["id"])
        for user in users
        if ascii_norm(user.get("name"))
    }

    user_cols: dict[int, str] = {}
    recognized: list[str] = []

    for c, value in enumerate(header):
        hn = ascii_norm(value)
        if not hn:
            continue

        target_name = aliases.get(hn, hn)
        user_id = users_by_name.get(target_name)

        if user_id:
            user_cols[c] = user_id
            recognized.append(f"{compact(value)}→{target_name}")

    if len(user_cols) < 3:
        raise RuntimeError(
            "Našel jsem méně než 3 sloupce aktivních hráčů. "
            f"Rozpoznané: {recognized}. Nic neimportuji."
        )

    # Sloupec dne: v souboru je B a hodnoty Monday ... Sunday.
    weekday_scores: list[tuple[int, int]] = []
    max_cols = max((len(r) for r in rows), default=0)

    excluded = set(user_cols) | {count_col, eliska_training_col}

    for c in range(max_cols):
        if c in excluded:
            continue
        score = 0
        for r in range(header_row + 1, len(rows)):
            value = rows[r][c] if c < len(rows[r]) else ""
            if parse_weekday(value) is not None:
                score += 1
        if score:
            weekday_scores.append((score, c))

    if not weekday_scores:
        raise RuntimeError(
            "Nedokážu najít sloupec s dny Monday–Sunday. Nic neimportuji."
        )

    weekday_scores.sort(reverse=True)
    weekday_col = weekday_scores[0][1]

    # Sloupec času: v souboru je C, hodnoty 7-8, 8-9, ... 21-22.
    time_scores: list[tuple[int, int]] = []
    excluded.add(weekday_col)

    for c in range(max_cols):
        if c in excluded:
            continue
        score = 0
        for r in range(header_row + 1, len(rows)):
            value = rows[r][c] if c < len(rows[r]) else ""
            if parse_time_range(value):
                score += 1
        if score:
            time_scores.append((score, c))

    if not time_scores:
        raise RuntimeError(
            "Nedokážu najít sloupec s časem (7-8, 8-9, ...). Nic neimportuji."
        )

    time_scores.sort(reverse=True)
    time_col = time_scores[0][1]

    return {
        "user_cols": user_cols,
        "weekday_col": weekday_col,
        "time_col": time_col,
        "recognized": recognized,
    }


def parse_weekly_slots(
    rows: list[list[str]],
    cfg: dict,
    users: list[dict],
) -> tuple[list[WeeklySlot], list[str], dict]:
    header_row, count_col, eliska_training_col = find_header(rows)
    cols = detect_columns(
        rows,
        header_row,
        users,
        count_col,
        eliska_training_col,
        cfg,
    )

    user_cols: dict[int, str] = cols["user_cols"]
    managed_user_ids = sorted(set(user_cols.values()))
    minimum_players = int(cfg.get("minimumPlayers", 3))

    print("Tréninkový kalendář: hráči = " + ", ".join(cols["recognized"]))

    current_weekday = None
    slots: list[WeeklySlot] = []
    stats = {
        "countRows": 0,
        "qualifiedRows": 0,
        "parsedQualifiedRows": 0,
    }

    def cell(row: list[str], c: int) -> str:
        if c < 0 or c >= len(row):
            return ""
        return compact(row[c])

    for r in range(header_row + 1, len(rows)):
        row = rows[r]

        weekday = parse_weekday(cell(row, cols["weekday_col"]))
        if weekday is not None:
            current_weekday = weekday

        count_raw = cell(row, count_col)
        count = parse_count(count_raw)

        available = {
            user_id
            for c, user_id in user_cols.items()
            if parse_bool(cell(row, c))
        }

        if count is not None:
            stats["countRows"] += 1
            qualifies = count >= minimum_players
        elif count_raw:
            stats["countRows"] += 1
            qualifies = parse_bool(count_raw)
        else:
            qualifies = False

        if not qualifies:
            continue

        stats["qualifiedRows"] += 1
        time_range = parse_time_range(cell(row, cols["time_col"]))

        if current_weekday is None or not time_range:
            print(
                f"VAROVÁNÍ: řádek {r + 1} má Trénink 3+ = {count_raw}, "
                "ale chybí rozpoznaný den nebo čas; přeskakuji."
            )
            continue

        start, end = time_range
        stats["parsedQualifiedRows"] += 1

        slots.append(WeeklySlot(
            weekday=current_weekday,
            start=start,
            end=end,
            eliska=parse_bool(cell(row, eliska_training_col)),
            available_user_ids=available,
        ))

    slots.sort(key=lambda s: (s.weekday, minutes(s.start), minutes(s.end)))

    if stats["countRows"] == 0:
        raise RuntimeError(
            "Ve sloupci 'Trenink 3+' jsem nenašel žádná čitelná data. "
            "Import zastavuji, aby se nesmazaly existující tréninky."
        )

    if stats["qualifiedRows"] > 0 and stats["parsedQualifiedRows"] == 0:
        raise RuntimeError(
            "Jsou tu řádky s 3+ hráči, ale ani u jednoho neumím přečíst den/čas. "
            "Import zastavuji, aby se nesmazaly existující tréninky."
        )

    return slots, managed_user_ids, stats


def merge_weekly_slots(slots: list[WeeklySlot]) -> list[WeeklyBlock]:
    blocks: list[WeeklyBlock] = []

    for slot in slots:
        if (
            blocks
            and blocks[-1].weekday == slot.weekday
            and blocks[-1].end == slot.start
            and blocks[-1].eliska == slot.eliska
        ):
            blocks[-1].end = slot.end
            blocks[-1].slots.append(slot)
        else:
            blocks.append(WeeklyBlock(
                weekday=slot.weekday,
                start=slot.start,
                end=slot.end,
                eliska=slot.eliska,
                slots=[slot],
            ))

    return blocks


def expand_blocks(
    weekly_blocks: list[WeeklyBlock],
    sync_from: date,
    sync_to: date,
) -> list[DatedBlock]:
    if sync_to < sync_from:
        return []

    by_weekday: dict[int, list[WeeklyBlock]] = {}
    for block in weekly_blocks:
        by_weekday.setdefault(block.weekday, []).append(block)

    result: list[DatedBlock] = []
    current = sync_from

    while current <= sync_to:
        for block in by_weekday.get(current.weekday(), []):
            result.append(DatedBlock(
                date=current.isoformat(),
                start=block.start,
                end=block.end,
                eliska=block.eliska,
                slots=block.slots,
            ))
        current += timedelta(days=1)

    return result


def build_payload(
    blocks: list[DatedBlock],
    managed_user_ids: list[str],
    cfg: dict,
) -> tuple[list[dict], list[dict]]:
    web_url = compact(cfg.get("webUrl")) or None
    location = compact(cfg.get("location")) or "Curling Brno"
    source_name = compact(cfg.get("name")) or "Tréninkový kalendář"

    events: list[dict] = []
    attendance: list[dict] = []

    for block in blocks:
        variant = "eliska" if block.eliska else "team"
        event_id = stable_id(block.date, block.start, variant)

        description = "Automaticky z týdenního tréninkového kalendáře."
        if block.eliska:
            description += " Eliška může v tomto bloku."

        events.append({
            "id": event_id,
            "type": "training",
            "title": "Trénink",
            "team": TEAM,
            "opponent": None,
            "date": block.date,
            "startTime": block.start,
            "endTime": block.end,
            "allDay": False,
            "location": location,
            "rink": None,
            "competition": None,
            "description": description,
            "source": {
                "type": "training_sheet",
                "name": source_name,
                "url": web_url,
            },
            "editable": False,
            "attendanceEnabled": True,
            "eliskaAvailable": block.eliska,
            "availabilitySlots": len(block.slots),
        })

        slot_count = len(block.slots)

        for user_id in managed_user_ids:
            available_count = sum(
                1
                for slot in block.slots
                if user_id in slot.available_user_ids
            )

            if available_count == slot_count:
                status = "yes"
            elif available_count > 0:
                status = "maybe"
            else:
                continue

            attendance.append({
                "eventId": event_id,
                "userId": user_id,
                "status": status,
            })

    return events, attendance


def main() -> None:
    cfg_all = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    cfg = cfg_all.get("trainingAvailability") or {}
    if not cfg:
        raise RuntimeError("V config/sources.json chybí trainingAvailability.")

    api_base = compact(os.getenv("API_BASE"))
    import_token = compact(os.getenv("IMPORT_TOKEN"))
    if not api_base or not import_token:
        raise RuntimeError("Chybí API_BASE nebo IMPORT_TOKEN.")

    rows = load_csv(cfg)
    users = load_users(api_base)

    weekly_slots, managed_user_ids, stats = parse_weekly_slots(rows, cfg, users)
    weekly_blocks = merge_weekly_slots(weekly_slots)

    sync_from = date.today()
    default_end = date(int(cfg.get("seasonStartYear", sync_from.year)) + 1, 6, 30)
    sync_to = parse_iso_date(cfg.get("seasonEndDate"), default_end)

    dated_blocks = expand_blocks(weekly_blocks, sync_from, sync_to)
    events, attendance = build_payload(dated_blocks, managed_user_ids, cfg)

    if len(events) > 500:
        raise RuntimeError(
            f"Vzniklo {len(events)} tréninků, API dovoluje nejvýš 500. "
            "Zkrať seasonEndDate."
        )
    if len(attendance) > 5000:
        raise RuntimeError(
            f"Vzniklo {len(attendance)} řádků docházky, API dovoluje nejvýš 5000."
        )

    print(
        "Tréninkový kalendář: řádky Trénink 3+ = "
        f"{stats['countRows']}, kvalifikované = {stats['qualifiedRows']}, "
        f"načtené = {stats['parsedQualifiedRows']}"
    )
    print(f"Tréninkový kalendář: týdenní bloky = {len(weekly_blocks)}")

    for block in weekly_blocks:
        extra = " • Eliška" if block.eliska else ""
        print(
            f"  {WEEKDAY_LABELS[block.weekday]} "
            f"{block.start}-{block.end}{extra}"
        )

    print(
        f"Tréninkový kalendář: generuji {sync_from.isoformat()} "
        f"až {sync_to.isoformat()} = {len(events)} tréninků"
    )

    r = requests.post(
        f"{api_base.rstrip('/')}/api/import-training-calendar",
        headers={
            "Authorization": f"Bearer {import_token}",
            "Content-Type": "application/json",
        },
        json={
            "events": events,
            "attendance": attendance,
            "managedUserIds": managed_user_ids,
            "syncFrom": sync_from.isoformat(),
        },
        timeout=90,
    )

    if not r.ok:
        raise RuntimeError(
            f"Import tréninků selhal HTTP {r.status_code}: {r.text[:1500]}"
        )

    print("Tréninkový kalendář D1:", r.text)


if __name__ == "__main__":
    main()
