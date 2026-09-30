export type ThemePref = "system" | "light" | "dark";
export const THEME_STORAGE_KEY = "theme";

/**
 * Sayfa çizilmeden önce çalışan betik (layout <head>): tercihi / sistemi okuyup <html data-theme> ayarlar.
 * Böylece açılışta yanlış renkte bir an yanıp sönme olmaz. localStorage erişilemezse sisteme uyar.
 */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement,p="system";try{p=localStorage.getItem("${THEME_STORAGE_KEY}")||"system"}catch(e){}var m=window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches;d.dataset.theme=p==="dark"||(p==="system"&&m)?"dark":"light";d.dataset.themePref=p})()`;
