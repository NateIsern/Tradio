import lighter
import asyncio
import sys
import os
import json

BASE_URL = "https://mainnet.zklighter.elliot.ai"
ACCOUNT_INDEX = int(os.environ.get("ACCOUNT_INDEX", "722509"))
API_KEY_INDEX = int(os.environ.get("API_KEY_INDEX", "4"))
PRIVATE_KEY = os.environ.get("LIGHTER_API_KEY", "")


def result_ok(tx_hash):
    print(json.dumps({"tx_hash": str(tx_hash), "status": "ok"}))


def result_err(err):
    print(json.dumps({"error": str(err)}))


async def main():
    action = sys.argv[1]
    client = lighter.SignerClient(
        url=BASE_URL,
        api_private_keys={API_KEY_INDEX: PRIVATE_KEY},
        account_index=ACCOUNT_INDEX,
    )

    if action == "create_order":
        market_index = int(sys.argv[2])
        client_order_index = int(sys.argv[3])
        base_amount = int(sys.argv[4])
        price = int(sys.argv[5])
        is_ask = sys.argv[6] == "true"
        tx, tx_hash, err = await client.create_order(
            market_index=market_index,
            client_order_index=client_order_index,
            base_amount=base_amount,
            price=price,
            is_ask=is_ask,
            order_type=client.ORDER_TYPE_MARKET,
            time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
            reduce_only=False,
            order_expiry=client.DEFAULT_IOC_EXPIRY,
        )
        result_err(err) if err else result_ok(tx_hash)

    elif action == "limit_order":
        market_index = int(sys.argv[2])
        client_order_index = int(sys.argv[3])
        base_amount = int(sys.argv[4])
        price = int(sys.argv[5])
        is_ask = sys.argv[6] == "true"
        tx, tx_hash, err = await client.create_order(
            market_index=market_index,
            client_order_index=client_order_index,
            base_amount=base_amount,
            price=price,
            is_ask=is_ask,
            order_type=client.ORDER_TYPE_LIMIT,
            time_in_force=client.ORDER_TIME_IN_FORCE_GOOD_TILL_TIME,
            reduce_only=False,
            order_expiry=client.DEFAULT_28_DAY_ORDER_EXPIRY,
        )
        result_err(err) if err else result_ok(tx_hash)

    elif action == "close_position":
        # Close a specific position by creating an opposite market order with reduce_only
        market_index = int(sys.argv[2])
        client_order_index = int(sys.argv[3])
        base_amount = int(sys.argv[4])
        price = int(sys.argv[5])
        is_ask = sys.argv[6] == "true"
        tx, tx_hash, err = await client.create_order(
            market_index=market_index,
            client_order_index=client_order_index,
            base_amount=base_amount,
            price=price,
            is_ask=is_ask,
            order_type=client.ORDER_TYPE_MARKET,
            time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
            reduce_only=True,
            order_expiry=client.DEFAULT_IOC_EXPIRY,
        )
        result_err(err) if err else result_ok(tx_hash)

    elif action == "stop_loss":
        market_index = int(sys.argv[2])
        client_order_index = int(sys.argv[3])
        base_amount = int(sys.argv[4])
        trigger_price = int(sys.argv[5])
        price = int(sys.argv[6])
        is_ask = sys.argv[7] == "true"
        tx, tx_hash, err = await client.create_sl_order(
            market_index=market_index,
            client_order_index=client_order_index,
            base_amount=base_amount,
            trigger_price=trigger_price,
            price=price,
            is_ask=is_ask,
            reduce_only=True,
        )
        result_err(err) if err else result_ok(tx_hash)

    elif action == "take_profit":
        market_index = int(sys.argv[2])
        client_order_index = int(sys.argv[3])
        base_amount = int(sys.argv[4])
        trigger_price = int(sys.argv[5])
        price = int(sys.argv[6])
        is_ask = sys.argv[7] == "true"
        tx, tx_hash, err = await client.create_tp_order(
            market_index=market_index,
            client_order_index=client_order_index,
            base_amount=base_amount,
            trigger_price=trigger_price,
            price=price,
            is_ask=is_ask,
            reduce_only=True,
        )
        result_err(err) if err else result_ok(tx_hash)

    elif action == "cancel_order":
        market_index = int(sys.argv[2])
        order_index = int(sys.argv[3])
        tx, tx_hash, err = await client.cancel_order(
            market_index=market_index,
            order_index=order_index,
        )
        result_err(err) if err else result_ok(tx_hash)

    elif action == "close_all":
        positions_json = sys.argv[2]
        positions = json.loads(positions_json)
        results = []
        for pos in positions:
            if float(pos["position"]) == 0:
                continue
            close_side = "SHORT" if pos["sign"] == "LONG" else "LONG"
            is_ask = close_side != "LONG"
            tx, tx_hash, err = await client.create_order(
                market_index=pos["marketId"],
                client_order_index=pos["clientOrderIndex"],
                base_amount=abs(int(float(pos["position"]) * pos["qtyDecimals"])),
                price=int((float(pos["latestPrice"]) * (1.01 if close_side == "LONG" else 0.99)) * pos["priceDecimals"]),
                is_ask=is_ask,
                order_type=client.ORDER_TYPE_MARKET,
                time_in_force=client.ORDER_TIME_IN_FORCE_IMMEDIATE_OR_CANCEL,
                reduce_only=True,
                order_expiry=client.DEFAULT_IOC_EXPIRY,
            )
            results.append({"symbol": pos["symbol"], "error": str(err) if err else None, "tx_hash": str(tx_hash)})
        print(json.dumps(results))


asyncio.run(main())
