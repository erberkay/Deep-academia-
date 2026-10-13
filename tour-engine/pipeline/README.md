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
7. `ba.py` bütün noktaların konum ve yönünü binlerce 3B nokta ile birlikte aynı anda inceltir
   (demet ayarı, SciPy `least_squares`, Huber kaybı). Birim yaklaşık metre; zemin ≈ -1,6 m, tavan ≈ +1,5 m.
8. `mono_depth.py` her nokta için yoğun derinlik üretir: küpten 10 adet 90° görüntü, Depth Anything V2
   (Base) tahmini, her görüntü demet ayarı noktalarına ve zemin/tavan düzlemlerine RANSAC ile oturtulur.
   Model z-derinliği verir; ışın uzaklığına cosθ ile çevrilir. `depth.py` (çok görüntülü stereo) gerçek
   veride zayıf kaldı; `mono_depth.py` yalnızca onun küp → equirect örneklemesini kullanır.
9. `web_depth.py` haritaları 512×256'ya küçültür, kameraya yakın ince yapıları (kafes, halat) arkadaki
   yüzeye katlar (ters derinlikte morfolojik açma, k=9) ve `tour.json`'a `depth` alanlarını yazar.
   PNG: R = üst 8 bit, G = alt 8 bit ters derinlik, `depthRange` arasında doğrusal.

Motor (`walker.js`) yürürken iki noktanın derinlik ağını ayrı ayrı çizip piksel piksel harmanlar:
gerilmiş yüzeyler gerçek yüzeylerin arkasına itilir, ağırlık = kameraya yakınlık × bakış açısı, üs 3.
Telefonda fotoğraflar GPU'ya kare başına bir yüz olarak önceden yüklenir.
