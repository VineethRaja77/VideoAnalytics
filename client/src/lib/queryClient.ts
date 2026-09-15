import { QueryClient, QueryFunction } from "@tanstack/react-query";

/**
 * A failed API call, with the server's own explanation kept intact.
 *
 * `throw new Error("422: {json blob}")` put the server's message inside a
 * string, so a screen wanting to show WHY something was rejected — which
 * photograph was too small, which coordinate was malformed — had to parse it
 * back out of the message. Those explanations are the whole point of the
 * error messages the API produces, so they are carried as data.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: any = null
  ) {
    super(message);
    this.name = "ApiError";
  }
}


export type Portal = "admin" | "client";

export function currentPortal(): Portal {
  return typeof window !== "undefined" && window.location.hash.startsWith("#/admin")
    ? "admin"
    : "client";
}

function portalHeaders(data?: unknown, portal: Portal = currentPortal()): HeadersInit {
  return {
    ...(data ? { "Content-Type": "application/json" } : {}),
    "X-VMS-Portal": portal,
  };
}

async function throwIfResNotOk(res: Response) {
  if (res.ok) return;
  const text = (await res.text()) || res.statusText;
  let body: any = null;
  let message = text;
  try {
    body = JSON.parse(text);
    // Every route in this API answers failures with { error: "..." }.
    if (body && typeof body.error === "string") message = body.error;
  } catch {
    /* not JSON — keep the raw text, it is still better than a status code */
  }
  throw new ApiError(res.status, message, body);
}

export async function apiRequestForPortal(
  portal: Portal,
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: portalHeaders(data, portal),
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  return apiRequestForPortal(currentPortal(), method, url, data);
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers: portalHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

/** apiRequest + JSON parse, for the common case. */
export async function apiJson<T>(
  method: string,
  url: string,
  data?: unknown
): Promise<T> {
  return (await apiRequest(method, url, data)).json() as Promise<T>;
}
