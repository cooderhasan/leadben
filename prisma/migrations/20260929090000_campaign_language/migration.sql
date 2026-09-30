-- Kampanya mesaj dili: yurt dışı kampanyalarda AI İngilizce yazar
ALTER TABLE "Campaign" ADD COLUMN "language" TEXT NOT NULL DEFAULT 'tr';
