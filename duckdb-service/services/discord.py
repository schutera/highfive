import os
import requests

DISCORD_WEBHOOK_URL = os.getenv(
    "DISCORD_WEBHOOK_URL",
    "https://discord.com/api/webhooks/1485907261774626888/nHzIRU3T2NGZxDlOx9mGWi50fBIWOx8CNI31nPtyum8ijjFaOIRkPzTtkh1oDHJIr4Qi",
)

if not DISCORD_WEBHOOK_URL:
    print("WARNING: DISCORD_WEBHOOK_URL is not set — Discord notifications are disabled")


def send_discord_message(content: str):
    if not DISCORD_WEBHOOK_URL:
        print(f"Discord message skipped (no webhook URL): {content[:80]}...")
        return
    try:
        resp = requests.post(DISCORD_WEBHOOK_URL, json={"content": content}, timeout=5)
        resp.raise_for_status()
    except Exception as e:
        print(f"Discord webhook failed: {e}")


def send_discord_file(file_path: str, message: str = ""):
    if not DISCORD_WEBHOOK_URL:
        print(f"Discord file skipped (no webhook URL): {file_path}")
        return False
    try:
        with open(file_path, "rb") as f:
            payload = {"content": message} if message else {}
            resp = requests.post(
                DISCORD_WEBHOOK_URL,
                data=payload,
                files={"file": (os.path.basename(file_path), f)},
                timeout=30,
            )
            resp.raise_for_status()
        return True
    except Exception as e:
        print(f"Discord file upload failed: {e}")
        return False
