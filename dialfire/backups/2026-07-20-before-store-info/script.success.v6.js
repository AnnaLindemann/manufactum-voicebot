var BACKEND_BASE_URL =
    "https://manufactum-voicebot-api-ohio-test.onrender.com";

    parameters.models = {
    main: { name: "gemini-3.1-flash-lite", thinking: 250 },
    data: { name: "gemini-3.1-flash-lite", thinking: 250 }
};

function hangup(args) {
    args = args || {};

    var confirmed =
        args.confirmed === true ||
        String(args.confirmed || "").toLowerCase() === "true";

    if (!confirmed) {
        return {
            status: "hangup_not_confirmed"
        };
    }

    actions.push({
        type: "hangup"
    });

    return {
        status: "ok"
    };
}

function getCurrentWeekDay() {
    var currentDate = new XTDate()
        .format("yyyy-MM-dd", "Europe/Berlin")
        .split("-");

    var year = Number(currentDate[0]);
    var month = Number(currentDate[1]) - 1;
    var day = Number(currentDate[2]);

    return [
        "Sonntag",
        "Montag",
        "Dienstag",
        "Mittwoch",
        "Donnerstag",
        "Freitag",
        "Samstag"
    ][new Date(Date.UTC(year, month, day)).getUTCDay()];
}

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/ä/g, "ae")
        .replace(/ö/g, "oe")
        .replace(/ü/g, "ue")
        .replace(/ß/g, "ss")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function normalizeWeekDay(value) {
    var day = normalizeText(value);

    var days = [
        "Sonntag",
        "Montag",
        "Dienstag",
        "Mittwoch",
        "Donnerstag",
        "Freitag",
        "Samstag"
    ];

    if (day === "heute") {
        return temp.weekDay || "";
    }

    if (day === "morgen") {
        var todayIndex = days.indexOf(temp.weekDay);

        return todayIndex === -1
            ? ""
            : days[(todayIndex + 1) % days.length];
    }

    var namedDays = {
        sonntag: "Sonntag",
        montag: "Montag",
        dienstag: "Dienstag",
        mittwoch: "Mittwoch",
        donnerstag: "Donnerstag",
        freitag: "Freitag",
        samstag: "Samstag"
    };

    return namedDays[day] || "";
}

function mapCandidates(candidates) {
    return candidates
        .slice(0, 3)
        .map(function (candidate) {
            return {
                storeId: String(candidate.storeId || ""),
                name: String(candidate.warehouseName || ""),
                address: String(candidate.address || "")
            };
        })
        .filter(function (candidate) {
            return candidate.storeId && candidate.name;
        });
}

function mapProducts(products, selectedStore) {
    return products
        .slice(0, 3)
        .map(function (product) {
            var availability = Array.isArray(product.availability)
                ? product.availability[0]
                : null;

            return {
                sku: String(product.sku || ""),
                name: String(product.name || ""),
                price: String(product.priceText || ""),
                description: String(product.description || ""),
                highlights: Array.isArray(product.highlights)
                    ? product.highlights
                          .slice(0, 3)
                          .map(function (highlight) {
                              return String(highlight || "");
                          })
                          .filter(function (highlight) {
                              return highlight;
                          })
                    : [],
                availabilityStatus:
                    selectedStore && availability
                        ? String(availability.status || "")
                        : ""
            };
        })
        .filter(function (product) {
            return product.sku && product.name && product.price;
        });
}

function capture_product_query(args) {
    args = args || {};

    var query = String(args.q || "").trim();
    var store = String(args.store || "").trim();
    var spelled = args.spelled === true;

    if (!query) {
        return {
            status: "invalid_request"
        };
    }

    var previous = temp.pendingProduct || null;

    if (spelled) {
        temp.productCorrectionCount = 0;
    } else if (
        previous &&
        normalizeText(previous.query) !== normalizeText(query)
    ) {
        temp.productCorrectionCount =
            Number(temp.productCorrectionCount || 0) + 1;
    } else if (!previous) {
        temp.productCorrectionCount = 0;
    }

  temp.pendingProduct = {
    query: query,
    store: store
};

temp.phase = 10;
LOG("manufactum_product_query_captured");

    if (temp.productCorrectionCount >= 2 && !spelled) {
        return {
            status: "spell_product"
        };
    }

    return {
        status: "confirm_product",
        query: query
    };
}

function confirm_product_query() {
    var pendingProduct = temp.pendingProduct;

    if (!pendingProduct || !pendingProduct.query) {
        return {
            status: "no_pending_product"
        };
    }

    LOG("manufactum_product_query_confirmed");

    return search_products({
        q: String(pendingProduct.query || "").trim(),
        store: String(pendingProduct.store || "").trim()
    });
}

function search_products(args) {
    args = args || {};

    var query = String(args.q || "").trim();
    var store = String(args.store || "").trim();
    var storeId = String(args.storeId || "").trim();
    var preserveProducts = args._preserveProducts === true;

    if (!query) {
        return {
            status: "invalid_request"
        };
    }

    temp.lastQuery = query;
    temp.selectedStore = null;
    temp.pendingStores = [];

    if (!preserveProducts) {
        temp.lastProducts = [];
    }

    var queryParts = [
        "q=" + encodeURIComponent(query),
        "limit=3"
    ];

    if (storeId) {
        queryParts.push("storeId=" + encodeURIComponent(storeId));
    } else if (store) {
        queryParts.push("store=" + encodeURIComponent(store));
    }

    try {
        LOG("manufactum_search_started");

 var response = GET(
    BACKEND_BASE_URL + "/api/products/search?" + queryParts.join("&"),
    {
        headers: {
            Accept: "application/json"
        }
    }
);

        if (response.status() < 200 || response.status() >= 300) {
            LOG("manufactum_search_unavailable");

            return {
                status: "unavailable"
            };
        }

        var body = response.json();
        var resolution = body.storeResolution || {};

        if (resolution.status === "ambiguous") {
            temp.pendingStores = mapCandidates(
                Array.isArray(resolution.candidates)
                    ? resolution.candidates
                    : []
            );

            LOG(
                "manufactum_store_ambiguous_candidates=" +
                    temp.pendingStores.length
            );
             
            temp.phase = 30;

            return {
                status: "ambiguous",
                stores: temp.pendingStores
            };
        }

        if (resolution.status === "matched" && resolution.selectedStore) {
            temp.selectedStore = {
                storeId: String(resolution.selectedStore.storeId || ""),
                name: String(resolution.selectedStore.warehouseName || ""),
                address: String(resolution.selectedStore.address || ""),
                phone: String(resolution.selectedStore.phone || ""),
                openingHours: resolution.selectedStore.openingHours || {}
            };
        }

        var products = Array.isArray(body.products) ? body.products : [];

        if (products.length === 0) {
            LOG("manufactum_search_no_results");
            
            temp.phase = 0;

            return {
                status: "no_results"
            };
        }

    temp.lastProducts = mapProducts(products, temp.selectedStore);

temp.phase = temp.selectedStore ? 40 : 20;

LOG("manufactum_search_ok_products=" + temp.lastProducts.length);

return {
    status: "ok",
    selectedStore: temp.selectedStore
        ? {
              name: temp.selectedStore.name,
              address: temp.selectedStore.address
          }
        : null,
    products: temp.lastProducts
};
    } catch (error) {
        LOG("manufactum_search_failed");

        return {
            status: "unavailable"
        };
    }
}

function search_in_city(args) {
    args = args || {};

    var store = String(args.store || "").trim();

    if (!temp.lastQuery) {
        return {
            status: "no_previous_query"
        };
    }

    if (!store) {
        return {
            status: "invalid_request"
        };
    }

    return search_products({
        q: temp.lastQuery,
        store: store,
        _preserveProducts: true
    });
}

function select_store(args) {
    args = args || {};

    var selection = normalizeText(args.selection);
    var informationType = String(args.type || "").trim();
    var requestedDay = String(args.day || "").trim();
    var pendingStores = Array.isArray(temp.pendingStores)
        ? temp.pendingStores
        : [];

    if (!temp.lastQuery || pendingStores.length === 0) {
        return {
            status: "no_pending_store_selection"
        };
    }

    if (!selection) {
        return {
            status: "invalid_request"
        };
    }

    var words = selection
        .split(" ")
        .filter(function (word) {
            return word.length >= 4;
        });

    var scoredStores = pendingStores.map(function (store) {
        var searchableText = normalizeText(
            store.name + " " + store.address
        );

        var score = words.filter(function (word) {
            return searchableText.indexOf(word) !== -1;
        }).length;

        return {
            store: store,
            score: score
        };
    });

    var highestScore = scoredStores.reduce(function (highest, item) {
        return Math.max(highest, item.score);
    }, 0);

    if (highestScore === 0) {
        return {
            status: "selection_not_found",
            stores: pendingStores
        };
    }

    var matches = scoredStores
        .filter(function (item) {
            return item.score === highestScore;
        })
        .map(function (item) {
            return item.store;
        });

    if (matches.length > 1) {
        return {
            status: "selection_ambiguous",
            stores: matches
        };
    }

    LOG("manufactum_store_selected");

    var searchResult = search_products({
        q: temp.lastQuery,
        storeId: matches[0].storeId,
        _preserveProducts: true
    });

    if (
        searchResult.status !== "ok" ||
        !temp.selectedStore ||
        !informationType
    ) {
        return searchResult;
    }

    if (informationType === "address") {
        return temp.selectedStore.address
            ? {
                  status: "ok",
                  type: "address",
                  storeName: temp.selectedStore.name,
                  address: temp.selectedStore.address
              }
            : {
                  status: "not_available",
                  type: "address"
              };
    }

    if (informationType === "phone") {
        return temp.selectedStore.phone
            ? {
                  status: "ok",
                  type: "phone",
                  storeName: temp.selectedStore.name,
                  phone: temp.selectedStore.phone
              }
            : {
                  status: "not_available",
                  type: "phone"
              };
    }

    if (informationType === "opening_hours") {
        var day = normalizeWeekDay(requestedDay);
        var openingHours = temp.selectedStore.openingHours || {};
        var hours = day ? String(openingHours[day] || "") : "";

        return day && hours
            ? {
                  status: "ok",
                  type: "opening_hours",
                  storeName: temp.selectedStore.name,
                  day: day,
                  hours: hours
              }
            : {
                  status: "not_available",
                  type: "opening_hours"
              };
    }

    return searchResult;
}

function get_selected_store_information(args) {
    args = args || {};

    if (!temp.selectedStore || !temp.selectedStore.name) {
        return {
            status: "no_selected_store"
        };
    }

    var informationType = String(args.type || "").trim();

    if (informationType === "address") {
        return temp.selectedStore.address
            ? {
                  status: "ok",
                  type: "address",
                  storeName: temp.selectedStore.name,
                  address: temp.selectedStore.address
              }
            : {
                  status: "not_available",
                  type: "address"
              };
    }

    if (informationType === "phone") {
        return temp.selectedStore.phone
            ? {
                  status: "ok",
                  type: "phone",
                  storeName: temp.selectedStore.name,
                  phone: temp.selectedStore.phone
              }
            : {
                  status: "not_available",
                  type: "phone"
              };
    }

    if (informationType === "opening_hours") {
        var day = normalizeWeekDay(args.day);
        var openingHours = temp.selectedStore.openingHours || {};
        var hours = day ? String(openingHours[day] || "") : "";

        return day && hours
            ? {
                  status: "ok",
                  type: "opening_hours",
                  storeName: temp.selectedStore.name,
                  day: day,
                  hours: hours
              }
            : {
                  status: "not_available",
                  type: "opening_hours"
              };
    }

    return {
        status: "invalid_request"
    };
}

function get_product_details(args) {
    args = args || {};

    var sku = String(args.sku || "").trim();
    var products = Array.isArray(temp.lastProducts)
        ? temp.lastProducts
        : [];

    var product = products.filter(function (item) {
        return item.sku === sku;
    })[0];

    if (!product) {
        return {
            status: "not_found"
        };
    }

    return {
        status: "ok",
        name: product.name,
        description: product.description,
        highlights: product.highlights
    };
}

function onLoad() {
    temp.language = "de";
    temp.phase = 0;
    temp.today = new XTDate().format(
        "dd.MM.yyyy HH:mm",
        "Europe/Berlin"
    );
    temp.weekDay = getCurrentWeekDay();
    temp.lastQuery = "";
    temp.lastProducts = [];
    temp.pendingStores = [];
    temp.selectedStore = null;
    temp.pendingProduct = null;
    temp.productCorrectionCount = 0;
}

function onUpdate() {
}

function onClose() {
}