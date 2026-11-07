import { Webhook } from "npm:standardwebhooks@1.0.0";

type SmsHookEvent = { user?: { phone?: unknown }; sms?: { otp?: unknown } };

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  const secret = Deno.env.get("SEND_SMS_HOOK_SECRET")?.replace(/^v1,whsec_/, "");
  const token = Deno.env.get("FONNTE_TOKEN");
  if (!secret || !token) return new Response(null, { status: 503 });

  const body = await request.text();
  if (body.length > 64_000) return new Response(null, { status: 413 });

  let event: SmsHookEvent | null;
  try {
    event = new Webhook(secret).verify(body, Object.fromEntries(request.headers)) as SmsHookEvent | null;
  } catch {
    return new Response(null, { status: 401 });
  }

  const phone = event?.user?.phone;
  const otp = event?.sms?.otp;
  if (typeof phone !== "string" || !/^\+?[1-9]\d{7,14}$/.test(phone) ||
      typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    return new Response(null, { status: 400 });
  }

  try {
    const message = new FormData();
    message.set("target", phone.replace(/^\+/, ""));
    message.set("countryCode", "0");
    message.set("message", `Kode verifikasi Aksesin: ${otp}. Jangan bagikan kode ini kepada siapa pun.`);

    const response = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: { Authorization: token },
      body: message,
      redirect: "error",
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok || (await response.json())?.status !== true) {
      return new Response(null, { status: 502 });
    }
    return new Response(null, { status: 200 });
  } catch {
    return new Response(null, { status: 502 });
  }
});
