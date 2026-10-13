# Küp yüzlerinden yürünebilir tur

Sitedeki `tour/` klasörü bu adımlarla üretildi (NumPy + OpenCV, ffmpeg, Node).

1. `edge_strips.sh` her yüzün 4 kenar şeridini çıkarır.
2. `group_faces.js` karışık yüzleri kenar sürekliliğinden küplere ayırır, tavan/zemin
   ve duvar sırasını bulur.
3. `build_cubes.py` yüzleri motorun yönüne çevirip 1024 ve 2048 boyutunda yazar.
4. `poses.py` her noktanın yerini ve yönünü fotoğraflardan hesaplar: SIFT eşleşmeleri,
   düz kamera + sabit yükseklik varsayımıyla kapsamlı arama, eğime izin veren 8 nokta
   inceltmesi, poz grafiği. `synth.html` ile kurulan sahte odada hatası 0,1° / 4 mm.
5. `bridge.py` sadece kapıdan bağlanan odaları (soyunma odaları) ana haritaya bağlar.
6. `make_tour.py` `tour.json` yazar; komşuluklar yalnızca birbirini gören çiftlerden,
   kadınlar soyunma odası koridordaki turuncu kapıdan geçişle.
