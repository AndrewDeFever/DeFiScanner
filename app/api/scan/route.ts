import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { scanEvm } from "@/lib/scanners/evm-scan";

export const runtime = "nodejs";

const Body = z.object({
  chain: z.enum(["eth"]).default("eth"),
  address: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const { chain, address } = Body.parse(json);

    const result = await scanEvm({ chain, address: address as `0x${string}` });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json(
      { error: true, message: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
