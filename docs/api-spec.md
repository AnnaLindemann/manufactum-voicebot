Searches for products in the warehouse inventory by a query string and filters results by a specific warehouse location.

## Request

**Method:** GET  
**Endpoint:** `https://warehouse-api.manufactum-dev.beyondtouch.io/search`

## Headers

| Key | Description |
| --- | --- |
| `x-api-key` | API key required for authentication. |

## Query Parameters

| Parameter | Required | Description |
| --- | --- | --- |
| `q` | Yes | The search query string (e.g. a product SKU or keyword). |
| `warehouse` | No | Filter results by a specific warehouse. Accepts either the `warehouse_id` (e.g. `MANUFACTUM_BERLIN_HAUS_HADENBERG`) or the warehouse phone number (e.g. `493024033844`). |
| `limit` | No | Maximum number of products to return. |

## Response

Returns a JSON object containing:

- `query` — The search term used.
    
- `result_count` — Number of products found.
    
- `products` — Array of matching product objects, each including:
    - `name` — Product name.
        
    - `sku` — Stock keeping unit identifier.
        
    - `manufacturer` — Manufacturer name.
        
    - `price` — Product price.
        
    - `product_url` — Link to the product page.
        
    - `description` — Product description.
        
    - `highlights` — Key selling points.
        
    - `warehouse_availability` — List of warehouse locations with availability info, address, phone, and opening hours.
        

## Example Response

``` json
{
  "query": "209567",
  "result_count": 1,
  "products": [
    {
      "name": "Bewässerungstopf zum Stecken",
      "sku": "209567",
      "manufacturer": "Karl Louis Lehmann",
      "price": "34,90 €",
      "product_url": "https://www.manufactum.de/bewaesserungstopf-stecken/p/209567/",
      "description": "Aus Terrakotta. Volumen ca. 800 ml. Ø 13 cm, Länge 20 cm. Gewicht 740 g. Hergestellt in Deutchland. Handarbeit, Form und Maße können leicht variieren.",
      "highlights": [
        "Kübelpflanzen seltener gießen und Wasser sparen",
        "Schnell und einfach: wird mit der Spitze in die Erde gesteckt",
        "Praktisch: auch in sehr dichten Wurzelballen verwendbar"
      ],
      "warehouse_availability": [
        {
          "warehouse_id": "MANUFACTUM_BERLIN_HAUS_HADENBERG",
          "warehouse": "Manufactum Berlin",
          "address": "Hardenbergstraße 4-5, 10623 Berlin",
          "phone": "+49 30 24033844",
          "opening_hours": {
            "Montag": "10:00 - 20:00 Uhr",
            "Dienstag": "10:00 - 20:00 Uhr",
            "Mittwoch": "10:00 - 20:00 Uhr",
            "Donnerstag": "10:00 - 20:00 Uhr",
            "Freitag": "10:00 - 20:00 Uhr",
            "Samstag": "10:00 - 18:00 Uhr",
            "Sonntag": "Geschlossen"
          },
          "status": "AVAILABLE",
          "status_text": "Verfügbar",
          "stock": 10
        }
      ]
    }
  ]
}

 ```