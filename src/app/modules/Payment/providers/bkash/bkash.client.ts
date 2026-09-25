/**
 * The only code that talks to bKash over HTTP. It never throws: every outcome,
 * including a timeout, comes back as a `BkashResult`, because a timed-out
 * execute may still have captured the money and the caller has to decide what
 * that means.
 */
import config from "../../../../../config";
import { getBkashToken, invalidateBkashToken } from "./bkash.token";

export type BkashOk<T> = { ok: true; data: T };
export type BkashErr = {
  ok: false;
  code: string;
  message: string;
  timeout?: boolean;
  httpStatus?: number;
  /** No token, so the request never left: bKash cannot have acted on it. */
  notSent?: boolean;
};
export type BkashResult<T> = BkashOk<T> | BkashErr;

type BkashEnvelope = {
  statusCode?: string;
  statusMessage?: string;
  errorCode?: string;
  errorMessage?: string;
  transactionStatus?: string;
  // The v2 APIs (refund) answer in their own shape.
  refundTransactionStatus?: string;
  externalCode?: string;
  errorMessageEn?: string;
};

const TIMEOUT_MS = 30_000;

const isAbort = (err: unknown) => {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

/** "01770618575" -> "017******75". */
export const maskMsisdn = (msisdn: string) =>
  msisdn.length < 6
    ? "***"
    : `${msisdn.slice(0, 3)}${"*".repeat(msisdn.length - 5)}${msisdn.slice(-2)}`;

/** What may be stored in `rawResponse`: no tokens, no full wallet number. */
export const redactBkash = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object") return raw;
  const {
    id_token: _idToken,
    refresh_token: _refreshToken,
    ...rest
  } = raw as Record<string, unknown>;
  if (typeof rest.customerMsisdn === "string") {
    rest.customerMsisdn = maskMsisdn(rest.customerMsisdn);
  }
  return rest;
};

const attempt = async <T>(
  url: string,
  body: object,
  auth: "credentials" | "token",
  accept: ((data: T) => boolean) | undefined,
  retried: boolean,
): Promise<BkashResult<T>> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  let token = "";
  if (auth === "credentials") {
    headers.username = config.bkash.username;
    headers.password = config.bkash.password;
  } else {
    try {
      token = await getBkashToken();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "TOKEN";
      return {
        ok: false,
        code,
        message: "Could not get a bKash token",
        timeout: code === "TIMEOUT" || undefined,
        notSent: true,
      };
    }
    headers.Authorization = token; // raw id_token, no "Bearer"
    headers["X-App-Key"] = config.bkash.appKey;
  }

  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return isAbort(err)
      ? { ok: false, code: "TIMEOUT", message: "bKash did not answer in time", timeout: true }
      : { ok: false, code: "NETWORK", message: "Could not reach bKash" };
  }

  // A token bKash no longer accepts: drop it everywhere and try once more with
  // a fresh one. A rejected request was not processed, so this is safe even
  // for execute.
  if (auth === "token" && !retried && (res.status === 401 || res.status === 403)) {
    await invalidateBkashToken(token);
    return attempt<T>(url, body, auth, accept, true);
  }

  let data: (T & BkashEnvelope) | null;
  try {
    data = (await res.json()) as (T & BkashEnvelope) | null;
  } catch (err) {
    return isAbort(err)
      ? { ok: false, code: "TIMEOUT", message: "bKash did not answer in time", timeout: true, httpStatus: res.status }
      : { ok: false, code: "BAD_RESPONSE", message: "bKash sent a response we could not read", httpStatus: res.status };
  }

  if (!data || typeof data !== "object") {
    return { ok: false, code: "BAD_RESPONSE", message: "bKash sent an empty response", httpStatus: res.status };
  }

  if (accept ? accept(data) : data.statusCode === "0000" && !data.errorCode) {
    return { ok: true, data };
  }

  return {
    ok: false,
    code: String(data.errorCode ?? data.externalCode ?? data.statusCode ?? `HTTP_${res.status}`),
    message: String(
      data.errorMessage ?? data.errorMessageEn ?? data.statusMessage ?? "bKash returned an error",
    ),
    httpStatus: res.status,
  };
};

export const bkashRequest = async <T>(
  path: string,
  body: object,
  opts: {
    auth: "credentials" | "token";
    op: string;
    tran?: string;
    /** `path` is a full URL rather than one under /tokenized/checkout (the v2 APIs). */
    absolute?: boolean;
    /** The success test, for APIs that do not answer statusCode "0000". */
    accept?: (data: T) => boolean;
  },
): Promise<BkashResult<T>> => {
  const started = Date.now();
  const url = opts.absolute ? path : `${config.bkash.baseUrl}/tokenized/checkout${path}`;
  const result = await attempt<T>(url, body, opts.auth, opts.accept, false);

  // One line per call. Never the body or headers: they carry the credentials,
  // the tokens and the customer's wallet number.
  console.log(
    "[bkash]",
    JSON.stringify({
      op: opts.op,
      tran: opts.tran,
      ms: Date.now() - started,
      code: result.ok ? "0000" : result.code,
      trxStatus: result.ok
        ? ((result.data as BkashEnvelope).transactionStatus ??
          (result.data as BkashEnvelope).refundTransactionStatus)
        : undefined,
    }),
  );

  return result;
};
