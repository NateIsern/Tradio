import type { Account } from "./accounts";
import { getAuthToken, fetchH2 } from "./auth";
import { BASE_URL } from "./config";

export async function getPortfolio(account: Account): Promise<{total: string, available: string}> {
    const token = getAuthToken();
    const body = await fetchH2(`${BASE_URL}/api/v1/account?by=index&value=${account.accountIndex}`, token);
    const data = JSON.parse(body) as { accounts: Array<{ collateral: string; available_balance: string }> };
    return { total: data.accounts[0]?.collateral ?? "0", available: data.accounts[0]?.available_balance ?? "0" };
}