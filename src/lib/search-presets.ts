/**
 * E-ticaret fırsatı modu için hazır aramalar (Konya oto yedek parça). Metin AI arama çözümleyicisine gider;
 * her biri Google Haritalar'da ayrı kategori taraması olur (tek aramada karışık kategori sonuç kalitesini düşürür).
 */
export const ECOMMERCE_SEARCH_PRESETS: Array<{ label: string; prompt: string }> = [
  { label: "Oto yedek parça", prompt: "Konya'daki oto yedek parça satıcıları" },
  { label: "Çıkma parça", prompt: "Konya'da çıkma oto parça satan işletmeler" },
  { label: "Ağır vasıta / kamyon", prompt: "Konya'da kamyon, tır ve ağır vasıta yedek parça satıcıları" },
  { label: "Traktör / tarım makinesi", prompt: "Konya'da traktör ve tarım makinesi yedek parçası satan işletmeler" },
  { label: "Motor / şanzıman", prompt: "Konya'da motor, şanzıman ve diferansiyel parçası satan dükkanlar" },
  { label: "Oto elektrik / akü", prompt: "Konya'da oto elektrik malzemesi ve akü satıcıları" },
  { label: "Fren / balata / amortisör", prompt: "Konya'da fren balata, amortisör ve süspansiyon parçası satıcıları" },
  { label: "Lastik / jant", prompt: "Konya'da oto lastik ve jant satıcıları" },
  { label: "Motosiklet parça", prompt: "Konya'da motosiklet yedek parça ve aksesuar satıcıları" },
  { label: "Oto aksesuar", prompt: "Konya'da oto aksesuar ve oto tuning malzemesi satan mağazalar" },
];
