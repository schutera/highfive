import os

import requests

DISCORD_WEBHOOK_URL = os.getenv(
    "DISCORD_WEBHOOK_URL",
    "https://discord.com/api/webhooks/1485907261774626888/nHzIRU3T2NGZxDlOx9mGWi50fBIWOx8CNI31nPtyum8ijjFaOIRkPzTtkh1oDHJIr4Qi",
)

if not DISCORD_WEBHOOK_URL:
    print(
        "WARNING: DISCORD_WEBHOOK_URL is not set — Discord notifications are disabled"
    )


def send_discord_message(content: str):
    if not DISCORD_WEBHOOK_URL:
        print(f"Discord message skipped (no webhook URL): {content[:80]}...")
        return
    try:
        resp = requests.post(DISCORD_WEBHOOK_URL, json={"content": content}, timeout=5)
        resp.raise_for_status()
    except Exception as e:
        print(f"Discord webhook failed: {e}")
