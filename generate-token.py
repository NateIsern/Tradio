import asyncio
import lighter
import os

BASE_URL = "https://mainnet.zklighter.elliot.ai"
ACCOUNT_INDEX = int(os.environ.get("ACCOUNT_INDEX", "722509"))
API_KEY_INDEX = int(os.environ.get("API_KEY_INDEX", "4"))
PRIVATE_KEY = os.environ.get("LIGHTER_API_KEY", "")

async def main():
    client = lighter.SignerClient(
        url=BASE_URL,
        api_private_keys={API_KEY_INDEX: PRIVATE_KEY},
        account_index=ACCOUNT_INDEX,
    )
    token, err = client.create_auth_token_with_expiry(
        deadline=21600,
        api_key_index=API_KEY_INDEX,
    )
    if err:
        print(f"ERROR:{err}", flush=True)
    else:
        print(token, flush=True)

asyncio.run(main())
