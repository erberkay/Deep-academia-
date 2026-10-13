# Panorama yürüyüş motoru

Gerçek 360° fotoğrafları klavyeyle, oyun karakteri gibi gezmek için kendi motorumuz.
Canlı siteye bağlı değil; fotoğraflar resmi yoldan geldiğinde siteye eklenecek.

## Kontroller

| Tuş | Hareket |
| --- | --- |
| ↑ / W | İleri yürü (basılı tutunca yürümeye devam eder) |
| ↓ / S | Geri |
| ← → / Q E | Dön (basılı tutunca yumuşakça döner) |
| A / D | Yana adım |
| Fare / parmak | Sürükle: etrafına bak · Dokun: o yöne yürü · Tekerlek: yakınlaş |

Her çekim noktasında fotoğraf olduğu gibi, tam kalitede görünür. Noktalar arasında kamera
bir fotoğraf küresinden diğerine kayarken görüntüler çapraz geçişle birleşir.

## Veri biçimi (`tour.json`)

```json
{
  "start": "p01",
  "nodes": [
    { "id": "p01", "src": "panos/p01.jpg", "pos": [0, 0, 0], "heading": 0 },
    { "id": "p02", "src": "panos/p02.jpg", "pos": [0, 0, -2.4], "heading": 0.12 }
  ]
}
```

- `src`: 2:1 equirectangular JPEG (ör. 8192×4096). Telefonda GPU sınırına göre otomatik küçültülür.
- `pos`: metre cinsinden konum, y yukarı; kuzey −Z. Konumlar varsa komşular otomatik bulunur.
- `heading`: fotoğrafın ortasının baktığı dünya yönü (radyan).
- Konum yoksa her bağlantı yönüyle verilir: `"links": [{ "to": "p02", "yaw": 1.57 }]`.

## Deneme

```bash
python3 -m http.server 8766 --directory tour-engine
```

`http://127.0.0.1:8766/` sahte deneme panoramalarıyla açılır; gerçek veri için
`?data=data/tour.json` ekleyin.
