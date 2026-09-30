import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "sos_session";

/**
 * Oturumsuz erişilebilen yollar. Bunların yetkisi kendi içinde doğrulanır:
 * - /u, /api/unsubscribe: imzalı ret anahtarı (alıcının oturumu yoktur — giriş sayfasına düşmemeli)
 * - /api/webhooks: paylaşılan gizli anahtar (e-posta sağlayıcısı çağırır)
 * - /api/cron: zamanlayıcı anahtarı
 * - /api/v1: REST API anahtarı (Authorization: Bearer)
 */
export const PUBLIC_PREFIXES = ["/login", "/register", "/u", "/api/unsubscribe", "/api/webhooks", "/api/cron", "/api/v1"];

export function isPublicPath(pathname: string): boolean {
  return pathname === "/" || PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Hızlı ön kontrol: oturum çerezi yoksa korumalı sayfalardan /login'e yönlendirir.
 * Gerçek oturum ve şirket üyeliği doğrulaması sunucu tarafında (layout / action) yapılır.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (!req.cookies.has(SESSION_COOKIE) && !isPublicPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
