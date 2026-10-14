#!/usr/bin/env python3
"""Build optional local Bay Area and Tahoe smoke loops from NWS imagery.

The Home Assistant card plays the images directly. This script is useful when
standalone animated WebP files are wanted. Run it every two hours; it skips
unchanged or stale publications and never mixes frames from different runs.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from io import BytesIO
import json
from pathlib import Path

from PIL import Image
import requests

BASE = "https://www.weather.gov/images/sto/HRRRSmoke/sto_hrrr_smoke_cwa_f{:02d}.png"
MAX_AGE = timedelta(hours=6)
SAME_PUBLICATION = timedelta(minutes=45)
REGIONS = {
    "bay-area": (150, 900, 800, 1450),
    "tahoe": (550, 630, 1200, 1180),
}
SOURCE_SIZE = (1200, 1545)


def frames(session: requests.Session) -> tuple[datetime, list[int]]:
    times: list[datetime | None] = []
    for hour in range(20):
        response = session.head(BASE.format(hour), timeout=15)
        if response.ok and response.headers.get("Content-Type", "").startswith("image/"):
            value = response.headers.get("Last-Modified")
            times.append(parsedate_to_datetime(value).astimezone(timezone.utc) if value else None)
        else:
            times.append(None)
    publication = times[0]
    if publication is None:
        raise RuntimeError("NWS has no current F00 image")
    if datetime.now(timezone.utc) - publication > MAX_AGE:
        raise RuntimeError(f"NWS image is stale: {publication.isoformat()}")
    matching = []
    for hour, stamp in enumerate(times):
        if stamp is None or abs(stamp - publication) > SAME_PUBLICATION:
            break
        matching.append(hour)
    if len(matching) < 2:
        raise RuntimeError("Not enough matching forecast frames yet")
    return publication, matching


def crop_region(image: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    width, height = image.size
    scaled = (
        round(box[0] * width / SOURCE_SIZE[0]),
        round(box[1] * height / SOURCE_SIZE[1]),
        round(box[2] * width / SOURCE_SIZE[0]),
        round(box[3] * height / SOURCE_SIZE[1]),
    )
    return image.crop(scaled).convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="directory for two animated WebP files")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "hrrr-smoke-card/1.0 (standalone smoke loop builder)"
    publication, hours = frames(session)
    manifest_path = args.output / "manifest.json"
    if manifest_path.exists():
        prior = json.loads(manifest_path.read_text())
        if prior.get("published_at") == publication.isoformat() and prior.get("hours") == hours:
            print("No new complete NWS loop")
            return

    images: list[Image.Image] = []
    for hour in hours:
        response = session.get(BASE.format(hour), timeout=30)
        response.raise_for_status()
        image = Image.open(BytesIO(response.content))
        image.load()
        images.append(image)

    for name, box in REGIONS.items():
        sequence = [crop_region(image, box) for image in images]
        target = args.output / f"{name}.webp"
        temporary = target.with_suffix(".webp.tmp")
        sequence[0].save(
            temporary, format="WEBP", save_all=True, append_images=sequence[1:],
            duration=950, loop=0, quality=82, method=4,
        )
        temporary.replace(target)
        print(f"Updated {target} ({len(sequence)} frames)")

    manifest = {
        "source": "NWS Sacramento HRRR near-surface smoke",
        "published_at": publication.isoformat(),
        "hours": hours,
        "regions": list(REGIONS),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
