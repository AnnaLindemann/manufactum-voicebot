import { describe, expect, it } from "vitest";
import { mapSearchResponse } from "../../src/integrations/manufactum/mapper.js";
import { upstreamSearchResponseSchema } from "../../src/integrations/manufactum/upstream-schema.js";
import { loadRedactedSample } from "../helpers/test-doubles.js";

/**
 * Contract test against the stored redacted Phase 1 sample.
 *
 * If upstream changes shape and the sample is refreshed, this test fails first — before the route,
 * the mapper, or a caller sees the difference.
 */
describe("stored redacted sample", () => {
  it("is accepted by the upstream schema", async () => {
    const sample = await loadRedactedSample();

    expect(sample.response.status).toBe(200);
    expect(upstreamSearchResponseSchema.safeParse(sample.response.body).success).toBe(true);
  });

  it("maps to the expected internal model", async () => {
    const sample = await loadRedactedSample();
    const parsed = upstreamSearchResponseSchema.parse(sample.response.body);

    const { result, unmappedUpstreamStatuses } = mapSearchResponse(parsed);

    expect(unmappedUpstreamStatuses).toEqual([]);
    expect(result).toEqual({
      query: "senf",
      resultCount: 2,
      products: [
        {
          sku: "218467",
          name: "Moutarde de Dijon",
          priceText: "11,90 €",
          description: "250-g-Fässchen",
          highlights: [
            "Zwischen Granitmühlsteinen kalt vermahlen",
            "Würzt Braten, Kurzgebratenes und Bratwurst",
            "Von Fallot, der letzten unabhängigen Senfmühle im Burgund",
          ],
          productUrl: "https://www.manufactum.de/moutarde-de-dijon-a218467/",
          availability: [
            {
              warehouseId: "MANUFACTUM_BERLIN_HAUS_HADENBERG",
              warehouseName: "Manufactum Berlin",
              address: "Hardenbergstraße 4-5, 10623 Berlin",
              phone: "+49 30 24033844",
              openingHours: {
                Montag: "10:00 - 20:00 Uhr",
                Dienstag: "10:00 - 20:00 Uhr",
                Mittwoch: "10:00 - 20:00 Uhr",
                Donnerstag: "10:00 - 20:00 Uhr",
                Freitag: "10:00 - 20:00 Uhr",
                Samstag: "10:00 - 18:00 Uhr",
                Sonntag: "Geschlossen",
              },
              status: "in_stock",
              stock: 7,
            },
          ],
        },
        {
          sku: "27815",
          name: "Schwerter Senf mit ganzen Körnern",
          priceText: "4,90 €",
          description: "185-ml-Glas",
          highlights: [
            "Mit Biss: mittelscharfer Senf mit ganzen gelben Senfkörnern",
            "Besonders gut zu Bratwurst oder Grillfleisch",
            "Handwerklich hergestellt in der Schwerter Senfmühle",
          ],
          productUrl: "https://www.manufactum.de/schwerter-senf-ganzen-koernern-a27815/",
          availability: [
            {
              warehouseId: "MANUFACTUM_BERLIN_HAUS_HADENBERG",
              warehouseName: "Manufactum Berlin",
              address: "Hardenbergstraße 4-5, 10623 Berlin",
              phone: "+49 30 24033844",
              openingHours: {
                Montag: "10:00 - 20:00 Uhr",
                Dienstag: "10:00 - 20:00 Uhr",
                Mittwoch: "10:00 - 20:00 Uhr",
                Donnerstag: "10:00 - 20:00 Uhr",
                Freitag: "10:00 - 20:00 Uhr",
                Samstag: "10:00 - 18:00 Uhr",
                Sonntag: "Geschlossen",
              },
              status: "in_stock",
              stock: 17,
            },
          ],
        },
      ],
    });
  });

  it("carries priceText through byte-identically from the sample", async () => {
    const sample = await loadRedactedSample();
    const parsed = upstreamSearchResponseSchema.parse(sample.response.body);

    const { result } = mapSearchResponse(parsed);

    for (const [index, product] of result.products.entries()) {
      expect(product.priceText).toBe(parsed.products[index]?.price);
    }
  });

  it("drops manufacturer and status_text at the mapping boundary", async () => {
    const sample = await loadRedactedSample();
    const { result } = mapSearchResponse(upstreamSearchResponseSchema.parse(sample.response.body));

    // Checked structurally, not by substring: the sample's manufacturer names also occur inside
    // product highlights, which are part of the contract and must survive the mapping.
    for (const product of result.products) {
      expect(product).not.toHaveProperty("manufacturer");

      for (const entry of product.availability) {
        expect(entry).not.toHaveProperty("status_text");
        expect(Object.keys(entry)).toEqual([
          "warehouseId",
          "warehouseName",
          "address",
          "phone",
          "openingHours",
          "status",
          "stock",
        ]);
      }
    }

    expect(JSON.stringify(result)).not.toContain("Edmond Fallot Moutardier");
  });

  it("contains no API key", async () => {
    const sample = await loadRedactedSample();

    expect(JSON.stringify(sample)).toContain("[REDACTED]");
  });
});
