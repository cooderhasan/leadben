"use server";

import { redirect } from "next/navigation";
import { processUnsubscribe } from "@/server/services/unsubscribe";

/** Herkese açık ret formu. Oturum gerekmez; yetki imzalı token ile doğrulanır. */
export async function unsubscribeAction(fd: FormData) {
  const token = String(fd.get("token") ?? "");
  const res = await processUnsubscribe(token);
  redirect(res.ok ? `/u/${token}?done=1` : `/u/${token}`);
}
