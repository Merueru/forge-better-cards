import json
import mimetypes
import os
import re
import tempfile
import threading
import time
import uuid
from copy import deepcopy
from datetime import datetime
from PIL import Image, ImageOps
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

from modules import script_callbacks


EXTENSION_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(EXTENSION_DIR, "data")
IMAGE_DIR = os.path.join(DATA_DIR, "images")
THUMB_DIR = os.path.join(IMAGE_DIR, ".thumbs")
CARDS_PATH = os.path.join(DATA_DIR, "better_cards.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")
BACKUP_PATH = os.path.join(BACKUP_DIR, "better_cards.json")
ENDPOINT_BASE = "/forge-better-cards"

MAX_CARDS = 100000
MAX_SETS_PER_CARD = 64
MAX_TEXT_LENGTH = 20000
MAX_IMAGE_BYTES = 25 * 1024 * 1024
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
LORA_EXTENSIONS = {".pt", ".ckpt", ".safetensors"}
THUMBNAIL_SIZE = 512
BACKUP_INTERVAL_SECONDS = 10 * 60
MISSING_LORA_CONFIRM_SECONDS = 10
_lock = threading.Lock()
_thumbnail_lock = threading.Lock()
_missing_lora_since = {}


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(IMAGE_DIR, exist_ok=True)


def default_card():
    return {
        "sets": [],
        "selected_set_id": "",
    }


def card_summary(card):
    return card_summary_with_usage(card, None)


def card_summary_with_usage(card, usage):
    has_card_data = isinstance(card, dict) and bool(card)
    sets = card.get("sets", []) if isinstance(card, dict) else []
    selected_set_id = card.get("selected_set_id", "") if isinstance(card, dict) else ""
    selected = next((item for item in sets if item.get("id") == selected_set_id), sets[0] if sets else {})
    usage = usage if isinstance(usage, dict) else {}

    return {
        "page": card.get("page", "") if isinstance(card, dict) else "",
        "name": card.get("name", "") if isinstance(card, dict) else "",
        "sort_path": card.get("sort_path", "") if isinstance(card, dict) else "",
        "sort_name": card.get("sort_name", "") if isinstance(card, dict) else "",
        "set_count": len(sets),
        "selected_set_id": selected_set_id,
        "selected_set_label": selected.get("label", ""),
        "selected_image_url": selected.get("image_url", ""),
        "updated_at": card.get("updated_at"),
        "use_count": int(parse_float(usage.get("use_count"), 0)),
        "last_used": int(parse_float(usage.get("last_used"), 0)),
        "has_card_data": has_card_data,
    }


def clamp_text(value, limit=MAX_TEXT_LENGTH):
    if not isinstance(value, str):
        return ""
    return value[:limit]


def parse_float(value, fallback):
    try:
        parsed = float(value)
        if parsed != parsed:
            return fallback
        return parsed
    except Exception:
        return fallback


def normalize_key(value):
    value = clamp_text(value, 1024).strip()
    if not value:
        raise ValueError("Missing card key")
    return value


def normalize_identity_value(value):
    return clamp_text(value, 2000).replace("\\", "/").strip().lower()


def card_matches_identity(card, page="", sort_path="", sort_name="", name="", require_path=False):
    if not isinstance(card, dict):
        return False

    page_value = normalize_identity_value(page)
    card_page = normalize_identity_value(card.get("page"))
    if page_value and card_page and page_value != card_page:
        return False

    names = {normalize_identity_value(name), normalize_identity_value(sort_name)}
    names.discard("")
    card_names = {normalize_identity_value(card.get("name")), normalize_identity_value(card.get("sort_name"))}
    card_names.discard("")
    if not names or not card_names or not names.intersection(card_names):
        return False

    path_value = normalize_identity_value(sort_path)
    card_path = normalize_identity_value(card.get("sort_path"))
    if path_value and card_path:
        return path_value == card_path
    return not require_path


def find_card_by_identity(data, page="", sort_path="", sort_name="", name=""):
    cards = data.get("cards", {})
    if not isinstance(cards, dict):
        return "", None

    for require_path in (True, False):
        for key, card in cards.items():
            if card_matches_identity(card, page, sort_path, sort_name, name, require_path=require_path):
                return key, card
    return "", None


def allowed_image_url(value):
    value = clamp_text(value, 2000).strip()
    if not value:
        return ""

    lower = value.lower()
    if re.search(r"\.(png|jpe?g|webp|gif)(?:$|[?#])", lower):
        return value
    if lower.startswith("./sd_extra_networks/thumb?") or lower.startswith("/sd_extra_networks/thumb?"):
        return value
    if lower.startswith("/forge-better-cards/image/") and re.search(r"\.(png|jpe?g|webp|gif)$", lower):
        return value

    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"}:
        path = parsed.path.lower()
        if re.search(r"\.(png|jpe?g|webp|gif)$", path):
            return value
        if path.endswith("/sd_extra_networks/thumb") and parsed.query:
            return value
        if "/forge-better-cards/image/" in path and re.search(r"\.(png|jpe?g|webp|gif)$", path):
            return value

    return ""


def normalize_set(item):
    if not isinstance(item, dict):
        item = {}

    set_id = clamp_text(item.get("id"), 80).strip()
    if not set_id:
        set_id = uuid.uuid4().hex

    label = clamp_text(item.get("label"), 160).strip()
    activation_text = clamp_text(item.get("activation_text"))
    negative_prompt = clamp_text(item.get("negative_prompt"))
    notes = clamp_text(item.get("notes"))
    image_url = allowed_image_url(item.get("image_url"))
    images = []
    raw_images = item.get("images", [])
    if isinstance(raw_images, list):
        for value in raw_images[:32]:
            value = allowed_image_url(value)
            if value and value not in images:
                images.append(value)
    if image_url and image_url not in images:
        images.insert(0, image_url)
    active_image_index = int(parse_float(item.get("active_image_index"), 0))
    if images:
        active_image_index = max(0, min(active_image_index, len(images) - 1))
        image_url = images[active_image_index]
    else:
        active_image_index = 0

    return {
        "id": set_id,
        "label": label or "Set",
        "activation_text": activation_text,
        "negative_prompt": negative_prompt,
        "notes": notes,
        "image_url": image_url,
        "images": images,
        "active_image_index": active_image_index,
    }


def normalize_card(payload):
    if not isinstance(payload, dict):
        payload = {}

    sets = []
    seen = set()
    for item in payload.get("sets", [])[:MAX_SETS_PER_CARD]:
        normalized = normalize_set(item)
        if normalized["id"] in seen:
            normalized["id"] = uuid.uuid4().hex
        seen.add(normalized["id"])
        sets.append(normalized)

    selected_set_id = clamp_text(payload.get("selected_set_id"), 80).strip()
    if sets and selected_set_id not in {item["id"] for item in sets}:
        selected_set_id = sets[0]["id"]

    return {
        "page": clamp_text(payload.get("page"), 80).strip(),
        "name": clamp_text(payload.get("name"), 512).strip(),
        "sort_path": clamp_text(payload.get("sort_path"), 2000).strip(),
        "sort_name": clamp_text(payload.get("sort_name"), 512).strip(),
        "sets": sets,
        "selected_set_id": selected_set_id,
        "updated_at": now_iso(),
    }


def read_data():
    ensure_dirs()
    if not os.path.exists(CARDS_PATH):
        return {"version": 1, "cards": {}, "usage": {}, "updated_at": None}

    try:
        with open(CARDS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        print(f"[ForgeBetterCards] Failed to read data: {exc}")
        return {"version": 1, "cards": {}, "usage": {}, "updated_at": None}

    if not isinstance(data, dict):
        return {"version": 1, "cards": {}, "usage": {}, "updated_at": None}

    cards = {}
    raw_cards = data.get("cards", {})
    if isinstance(raw_cards, dict):
        for key, value in list(raw_cards.items())[:MAX_CARDS]:
            try:
                cards[normalize_key(key)] = normalize_card(value)
            except Exception:
                continue

    usage = {}
    raw_usage = data.get("usage", {})
    if isinstance(raw_usage, dict):
        for key, value in list(raw_usage.items())[:MAX_CARDS]:
            if not isinstance(value, dict):
                continue
            try:
                usage[normalize_key(key)] = {
                    "use_count": max(0, int(parse_float(value.get("use_count"), 0))),
                    "last_used": max(0, int(parse_float(value.get("last_used"), 0))),
                }
            except Exception:
                continue

    return {
        "version": 1,
        "cards": cards,
        "usage": usage,
        "updated_at": data.get("updated_at"),
    }


def backup_current_data(force=False):
    if not os.path.isfile(CARDS_PATH):
        return False
    if not force and os.path.isfile(BACKUP_PATH):
        if time.time() - os.path.getmtime(BACKUP_PATH) < BACKUP_INTERVAL_SECONDS:
            return False

    with open(CARDS_PATH, "r", encoding="utf-8") as source:
        current = json.load(source)
    if not isinstance(current, dict) or not isinstance(current.get("cards", {}), dict):
        raise ValueError("Current Better Cards data is not a valid card database")

    os.makedirs(BACKUP_DIR, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix="better-cards-backup-", suffix=".json", dir=BACKUP_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            json.dump(current, target, indent=2, ensure_ascii=False)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temp_path, BACKUP_PATH)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
    return True


def write_data(data, force_backup=False):
    ensure_dirs()
    try:
        backup_current_data(force=force_backup)
    except Exception as exc:
        print(f"[ForgeBetterCards] Failed to create rolling backup: {exc}")
        if force_backup:
            raise RuntimeError("Could not create a required Better Cards backup") from exc

    serializable = {
        "version": 1,
        "cards": data.get("cards", {}),
        "usage": data.get("usage", {}),
        "updated_at": now_iso(),
    }

    fd, temp_path = tempfile.mkstemp(prefix="better-cards-", suffix=".json", dir=DATA_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(serializable, f, indent=2, ensure_ascii=False)
        os.replace(temp_path, CARDS_PATH)
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass

    return serializable


def lora_allowed_directories():
    from modules import shared

    return [os.fspath(path) for path in [shared.cmd_opts.lora_dir, *shared.cmd_opts.lora_dirs] if path]


def path_is_within(path, root):
    candidate = os.path.normcase(os.path.realpath(os.path.abspath(os.fspath(path))))
    parent = os.path.normcase(os.path.realpath(os.path.abspath(os.fspath(root))))
    try:
        return os.path.commonpath([candidate, parent]) == parent
    except ValueError:
        return False


def validate_lora_model_path(filename, allowed_dirs):
    candidate = os.path.abspath(os.fspath(filename))
    if not os.path.isfile(candidate):
        raise FileNotFoundError("LoRA file not found")
    if os.path.islink(candidate) or os.path.realpath(candidate) != candidate:
        raise ValueError("Refusing to delete a symlinked LoRA file")
    if os.path.splitext(candidate)[1].lower() not in LORA_EXTENSIONS:
        raise ValueError("File is not a supported LoRA model")
    if not any(path_is_within(candidate, root) for root in allowed_dirs):
        raise ValueError("LoRA file is outside Forge's configured LoRA directories")
    return candidate


def resolve_lora_model_path(name, expected_path=""):
    import networks

    network_on_disk = networks.available_networks.get(name)
    if network_on_disk is None:
        raise FileNotFoundError("LoRA is no longer available in Forge")

    candidate = validate_lora_model_path(network_on_disk.filename, lora_allowed_directories())
    if expected_path and os.path.normcase(os.path.abspath(expected_path)) != os.path.normcase(candidate):
        raise ValueError("LoRA card path changed; refresh the LoRA list and try again")
    return candidate


def lora_card_file_exists(card):
    path = clamp_text(card.get("sort_path"), 2000).strip()
    if path and os.path.isfile(path):
        return True

    names = {
        normalize_identity_value(card.get("name")),
        normalize_identity_value(os.path.splitext(clamp_text(card.get("sort_name"), 512))[0]),
    }
    names.discard("")
    if not names:
        return False
    try:
        import networks

        for network_name, network_on_disk in networks.available_networks.items():
            network_names = {
                normalize_identity_value(network_name),
                normalize_identity_value(os.path.splitext(os.path.basename(network_on_disk.filename))[0]),
            }
            if names.intersection(network_names) and os.path.isfile(network_on_disk.filename):
                return True
        return False
    except Exception:
        return False


def confirmed_missing_lora_keys(data, now=None, allowed_dirs=None):
    current_time = time.monotonic() if now is None else float(now)
    roots = lora_allowed_directories() if allowed_dirs is None else allowed_dirs
    active_keys = set()
    confirmed = []

    for key, card in data.get("cards", {}).items():
        if not isinstance(card, dict) or normalize_identity_value(card.get("page")) != "lora":
            _missing_lora_since.pop(key, None)
            continue

        path = clamp_text(card.get("sort_path"), 2000).strip()
        if not path or os.path.splitext(path)[1].lower() not in LORA_EXTENSIONS:
            _missing_lora_since.pop(key, None)
            continue
        matching_roots = [root for root in roots if path_is_within(path, root)]
        if not matching_roots or not any(os.path.isdir(root) for root in matching_roots):
            _missing_lora_since.pop(key, None)
            continue

        active_keys.add(key)
        if lora_card_file_exists(card):
            _missing_lora_since.pop(key, None)
            continue

        first_seen = _missing_lora_since.setdefault(key, current_time)
        if current_time - first_seen >= MISSING_LORA_CONFIRM_SECONDS:
            confirmed.append(key)

    for key in list(_missing_lora_since):
        if key not in active_keys:
            _missing_lora_since.pop(key, None)
    return confirmed


def reconcile_missing_loras(data):
    missing_keys = confirmed_missing_lora_keys(data)
    if not missing_keys:
        return data, []

    cleaned = deepcopy(data)
    for key in missing_keys:
        cleaned.get("cards", {}).pop(key, None)
        cleaned.get("usage", {}).pop(key, None)

    try:
        cleaned = write_data(cleaned, force_backup=True)
    except Exception as exc:
        print(f"[ForgeBetterCards] Skipped missing LoRA cleanup because backup failed: {exc}")
        return data, []

    for key in missing_keys:
        _missing_lora_since.pop(key, None)
    return cleaned, missing_keys


def safe_image_filename(original_name):
    _, ext = os.path.splitext(original_name or "")
    ext = ext.lower()
    if ext not in IMAGE_EXTENSIONS:
        ext = ".png"

    stem = re.sub(r"[^a-zA-Z0-9._-]+", "-", os.path.splitext(original_name or "image")[0]).strip(".-")
    stem = stem[:60] or "image"
    return f"{stem}-{uuid.uuid4().hex[:12]}{ext}"


def image_extension_from_content(content):
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if content.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if content.startswith(b"GIF87a") or content.startswith(b"GIF89a"):
        return ".gif"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    return ""


def thumbnail_cache_path(source_path, size):
    source_name = os.path.basename(source_path)
    source_ext = os.path.splitext(source_name)[1].lower()
    output_ext = ".png" if source_ext in {".png", ".gif"} else ".jpg"
    return os.path.join(THUMB_DIR, f"{size}-{source_name}{output_ext}")


def create_thumbnail(source_path, size):
    cache_path = thumbnail_cache_path(source_path, size)
    if os.path.isfile(cache_path) and os.path.getmtime(cache_path) >= os.path.getmtime(source_path):
        return cache_path

    os.makedirs(THUMB_DIR, exist_ok=True)
    temp_fd, temp_path = tempfile.mkstemp(prefix="thumb-", suffix=os.path.splitext(cache_path)[1], dir=THUMB_DIR)
    os.close(temp_fd)
    try:
        with Image.open(source_path) as source:
            image = ImageOps.exif_transpose(source)
            image = ImageOps.fit(
                image,
                (size, round(size * 1.5)),
                method=Image.Resampling.LANCZOS,
                centering=(0.5, 0.5),
            )
            if cache_path.endswith(".png"):
                if image.mode not in {"L", "LA", "P", "RGB", "RGBA"}:
                    image = image.convert("RGBA")
                image.save(temp_path, format="PNG", optimize=True)
            else:
                if image.mode not in {"L", "RGB"}:
                    image = image.convert("RGB")
                image.save(temp_path, format="JPEG", quality=82, optimize=True)
        os.replace(temp_path, cache_path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    return cache_path


def ensure_storage_file():
    ensure_dirs()
    if not os.path.exists(CARDS_PATH):
        write_data({"cards": {}})
        return

    try:
        with open(CARDS_PATH, "r", encoding="utf-8") as f:
            raw_cards = json.load(f).get("cards", {})
        has_legacy_weight = any(
            isinstance(card, dict) and (
                any(key.startswith("weight_") for key in card) or
                any(isinstance(item, dict) and "weight" in item for item in card.get("sets", []))
            )
            for card in raw_cards.values()
        ) if isinstance(raw_cards, dict) else False
    except Exception:
        has_legacy_weight = False

    if has_legacy_weight:
        write_data(read_data())


def register_routes(demo, app: FastAPI):
    with _lock:
        ensure_storage_file()

    @app.get(f"{ENDPOINT_BASE}/config")
    async def get_config():
        return JSONResponse({
            "ok": True,
            "auto_seed_from_cardmaster": True,
        })

    @app.get(f"{ENDPOINT_BASE}/card")
    async def get_card(key: str = "", page: str = "", sort_path: str = "", sort_name: str = "", name: str = ""):
        try:
            key = normalize_key(key) if key else ""
            with _lock:
                data = read_data()
                card = data["cards"].get(key) if key else None
                actual_key = key
                if card is None:
                    actual_key, card = find_card_by_identity(data, page, sort_path, sort_name, name)
            return JSONResponse({"ok": True, "found": card is not None, "key": actual_key, "card": card or default_card()})
        except Exception as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    @app.get(f"{ENDPOINT_BASE}/index")
    async def get_index():
        try:
            with _lock:
                data = read_data()
                data, removed_missing_loras = reconcile_missing_loras(data)
                cards = {
                    key: card_summary_with_usage(card, data.get("usage", {}).get(key))
                    for key, card in data["cards"].items()
                }
                for key, usage in data.get("usage", {}).items():
                    if key not in cards:
                        cards[key] = card_summary_with_usage({}, usage)
            return JSONResponse({
                "ok": True,
                "cards": cards,
                "updated_at": data.get("updated_at"),
                "removed_missing_loras": len(removed_missing_loras),
            })
        except Exception as exc:
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    @app.post(f"{ENDPOINT_BASE}/usage")
    async def record_usage(request: Request):
        try:
            payload = await request.json()
            key = normalize_key(payload.get("key", ""))
            now_ms = int(time.time() * 1000)

            with _lock:
                data = read_data()
                usage = data.setdefault("usage", {})
                entry = usage.setdefault(key, {"use_count": 0, "last_used": 0})
                entry["use_count"] = max(0, int(parse_float(entry.get("use_count"), 0))) + 1
                entry["last_used"] = now_ms
                data = write_data(data)

            return JSONResponse({"ok": True, "usage": data["usage"][key], "updated_at": data["updated_at"]})
        except Exception as exc:
            print(f"[ForgeBetterCards] Failed to record usage: {exc}")
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    @app.post(f"{ENDPOINT_BASE}/card")
    async def save_card(request: Request):
        try:
            payload = await request.json()
            key = normalize_key(payload.get("key", ""))
            card = normalize_card(payload.get("card", {}))

            with _lock:
                data = read_data()
                data["cards"][key] = card
                data = write_data(data)

            return JSONResponse({"ok": True, "card": data["cards"][key], "updated_at": data["updated_at"]})
        except Exception as exc:
            print(f"[ForgeBetterCards] Failed to save card: {exc}")
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    @app.delete(f"{ENDPOINT_BASE}/card")
    async def reset_card(request: Request):
        try:
            payload = await request.json()
            key = normalize_key(payload.get("key", "")) if payload.get("key") else ""
            page = clamp_text(payload.get("page"), 80).strip()
            sort_path = clamp_text(payload.get("sort_path"), 2000).strip()
            sort_name = clamp_text(payload.get("sort_name"), 512).strip()
            name = clamp_text(payload.get("name"), 512).strip()

            with _lock:
                data = read_data()
                actual_key = key if key in data.get("cards", {}) else ""
                if not actual_key:
                    actual_key, _card = find_card_by_identity(data, page, sort_path, sort_name, name)
                if actual_key:
                    data.get("cards", {}).pop(actual_key, None)
                    data.get("usage", {}).pop(actual_key, None)
                    data = write_data(data)

            return JSONResponse({"ok": True, "key": actual_key, "updated_at": data.get("updated_at")})
        except Exception as exc:
            print(f"[ForgeBetterCards] Failed to reset card: {exc}")
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    @app.delete(f"{ENDPOINT_BASE}/lora")
    async def delete_lora(request: Request):
        model_deleted = False
        try:
            payload = await request.json()
            key = normalize_key(payload.get("key", ""))
            page = clamp_text(payload.get("page"), 80).strip().lower()
            name = clamp_text(payload.get("name"), 512).strip()
            sort_path = clamp_text(payload.get("sort_path"), 2000).strip()
            sort_name = clamp_text(payload.get("sort_name"), 512).strip()
            if page != "lora" or not name or not sort_path:
                raise ValueError("Delete is only available for a current LoRA card")

            model_path = resolve_lora_model_path(name, expected_path=sort_path)
            delete_mode = payload.get("delete_mode", "model")
            if delete_mode not in ("model", "files"):
                raise ValueError("Unknown delete mode")
            companion_paths = []
            if delete_mode == "files":
                stem = os.path.splitext(model_path)[0]
                shared_stem = any(
                    os.path.isfile(stem + extension)
                    and os.path.normcase(stem + extension) != os.path.normcase(model_path)
                    for extension in LORA_EXTENSIONS
                )
                if not shared_stem:
                    suffixes = [".json"]
                    for extension in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"):
                        suffixes.extend((extension, ".preview" + extension))
                    for suffix in suffixes:
                        companion = stem + suffix
                        if os.path.isfile(companion):
                            if os.path.islink(companion) or os.path.normcase(os.path.realpath(companion)) != os.path.normcase(os.path.abspath(companion)):
                                raise ValueError("Cannot delete linked companion files")
                            companion_paths.append(companion)
            with _lock:
                data = read_data()
                actual_key = key if key in data.get("cards", {}) else ""
                if not actual_key:
                    actual_key, _card = find_card_by_identity(data, page, sort_path, sort_name, name)

                if os.path.isfile(CARDS_PATH):
                    try:
                        backup_current_data(force=True)
                    except Exception as exc:
                        raise RuntimeError("Could not create a required Better Cards backup") from exc

                os.remove(model_path)
                model_deleted = True

                changed = False
                keys_to_remove = {value for value in (key, actual_key) if value}
                for card_key in keys_to_remove:
                    if data.get("cards", {}).pop(card_key, None) is not None:
                        changed = True
                    if data.get("usage", {}).pop(card_key, None) is not None:
                        changed = True
                    _missing_lora_since.pop(card_key, None)
                if changed:
                    data = write_data(data)
                for companion in companion_paths:
                    os.remove(companion)

            return JSONResponse({
                "ok": True,
                "key": actual_key or key,
                "name": name,
                "better_cards_removed": changed,
                "images_kept": True,
                "forge_metadata_kept": not any(path.lower().endswith(".json") for path in companion_paths),
                "updated_at": data.get("updated_at"),
            })
        except (FileNotFoundError, ValueError) as exc:
            return JSONResponse({"ok": False, "error": str(exc), "model_deleted": model_deleted}, status_code=400)
        except PermissionError as exc:
            print(f"[ForgeBetterCards] LoRA delete permission denied: {exc}")
            return JSONResponse({"ok": False, "error": "Permission denied while deleting the LoRA file", "model_deleted": model_deleted}, status_code=403)
        except Exception as exc:
            print(f"[ForgeBetterCards] Failed to delete LoRA: {exc}")
            return JSONResponse({"ok": False, "error": "Could not delete the LoRA safely", "model_deleted": model_deleted}, status_code=500)

    @app.post(f"{ENDPOINT_BASE}/upload-image")
    async def upload_image(request: Request):
        try:
            form = await request.form()
            upload = form.get("image") or form.get("file")
            if upload is None or not hasattr(upload, "filename"):
                raise ValueError("Missing image upload")

            original_name = upload.filename or "image.png"
            content = await upload.read(MAX_IMAGE_BYTES + 1)
            if len(content) > MAX_IMAGE_BYTES:
                raise ValueError("Image is too large")
            ext = image_extension_from_content(content)
            if not ext:
                raise ValueError("Upload must be a PNG, JPEG, WebP, or GIF image")

            filename = safe_image_filename(original_name)
            if os.path.splitext(filename)[1].lower() != ext:
                filename = os.path.splitext(filename)[0] + ext
            output_path = os.path.join(IMAGE_DIR, filename)

            with open(output_path, "wb") as f:
                f.write(content)

            return JSONResponse({
                "ok": True,
                "filename": filename,
                "url": f"{ENDPOINT_BASE}/image/{filename}",
            })
        except Exception as exc:
            print(f"[ForgeBetterCards] Failed to upload image: {exc}")
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    @app.get(f"{ENDPOINT_BASE}/image/{{filename}}")
    def get_image(filename: str, size: int = 0):
        safe_name = os.path.basename(filename)
        path = os.path.join(IMAGE_DIR, safe_name)
        if not os.path.isfile(path):
            return JSONResponse({"ok": False, "error": "Image not found"}, status_code=404)

        media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        headers = {"Cache-Control": "public, max-age=86400"}
        if size == THUMBNAIL_SIZE:
            with _thumbnail_lock:
                thumb_path = create_thumbnail(path, size)
            thumb_type = mimetypes.guess_type(thumb_path)[0] or "image/jpeg"
            return FileResponse(thumb_path, media_type=thumb_type, headers=headers)
        return FileResponse(path, media_type=media_type, headers=headers)

script_callbacks.on_app_started(register_routes)
