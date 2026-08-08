import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { assertAllowedHost, assertHeavyGetMetadata } from "@/app/requestSecurity";

const COMPANY_LANDING_PATH = /^\/company\/[^/]+\/?$/;

/** Request-wide local trust boundary. Next invokes this for every request. */
export function proxy(request: NextRequest): Response {
  const rejectedHost = assertAllowedHost(request);
  if (rejectedHost !== null) return rejectedHost;

  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    const pathname = new URL(request.url).pathname;
    if (COMPANY_LANDING_PATH.test(pathname)) {
      const rejectedMetadata = assertHeavyGetMetadata(request);
      if (rejectedMetadata !== null) return rejectedMetadata;
    }
  }

  return NextResponse.next();
}
