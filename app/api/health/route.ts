import { NextResponse } from "next/server";

export function GET(): NextResponse<{ ok: true }> {
  return NextResponse.json({ ok: true });
}
