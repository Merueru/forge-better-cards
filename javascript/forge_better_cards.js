(function() {
    "use strict";

    const ROOT = (window.gradio_config && window.gradio_config.root) || "";
    const BASE = `${ROOT}/forge-better-cards`;
    const state = {
        config: null,
        index: null,
        indexPromise: null,
        cards: new Map(),
        loadingCards: new Map(),
        saveTimers: new Map(),
        saveChains: new Map(),
        saveVersions: new Map(),
        scheduled: false,
        mutationObserver: null,
        cardObserver: null,
        cardBatchToken: 0,
        observedCards: new WeakSet(),
        preloadedImages: new Set(),
        promptInsertions: new Map(),
        directorySearchPatched: false,
        metadataScrollLockUntil: 0,
        bootRefreshUntil: 0,
    };

    function enc(value) {
        return encodeURIComponent(value == null ? "" : String(value));
    }

    function base64Url(value) {
        const encoded = btoa(unescape(encodeURIComponent(value)));
        return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    }

    function escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function escapeAttributeValue(value) {
        return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    }

    function getApp() {
        return typeof gradioApp === "function" ? gradioApp() : document;
    }

    function globalFn(name) {
        if (typeof window[name] === "function") return window[name];
        try {
            const fn = Function(`return typeof ${name} === "function" ? ${name} : null`)();
            return typeof fn === "function" ? fn : null;
        } catch (error) {
            return null;
        }
    }

    function randomId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }
        return `fbc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }

    function optionalNumber(value) {
        if (value == null || value === "") return NaN;
        const number = Number(value);
        return Number.isFinite(number) ? number : NaN;
    }

    function cloneCard(card) {
        return JSON.parse(JSON.stringify(card || {}));
    }

    function normalizeSet(set, config) {
        const fallbackWeight = config ? config.weight_default : 1;
        let images = Array.isArray(set && set.images) ? set.images.filter(Boolean).map(String) : [];
        const legacyImage = set && set.image_url ? String(set.image_url) : "";
        if (legacyImage && !images.includes(legacyImage)) images.unshift(legacyImage);
        let activeImageIndex = Number(set && set.active_image_index);
        if (!Number.isFinite(activeImageIndex)) activeImageIndex = 0;
        if (images.length) activeImageIndex = Math.max(0, Math.min(activeImageIndex, images.length - 1));
        return {
            id: set && set.id ? String(set.id) : randomId(),
            label: set && set.label ? String(set.label) : "Set",
            activation_text: set && set.activation_text ? String(set.activation_text) : "",
            negative_prompt: set && set.negative_prompt ? String(set.negative_prompt) : "",
            notes: set && set.notes ? String(set.notes) : "",
            weight: Number.isFinite(Number(set && set.weight)) ? Number(set.weight) : fallbackWeight,
            image_url: images.length ? images[activeImageIndex] : legacyImage,
            images,
            active_image_index: activeImageIndex,
        };
    }

    function defaultCard(identity) {
        const cfg = state.config || {};
        return {
            page: identity ? identity.page : "",
            name: identity ? identity.name : "",
            sort_path: identity ? identity.sortPath : "",
            sort_name: identity ? identity.sortName : "",
            sets: [],
            selected_set_id: "",
            weight_min: Number.isFinite(Number(cfg.weight_min)) ? Number(cfg.weight_min) : -4,
            weight_max: Number.isFinite(Number(cfg.weight_max)) ? Number(cfg.weight_max) : 4,
            weight_step: Number.isFinite(Number(cfg.weight_step)) ? Number(cfg.weight_step) : 0.05,
            weight_default: Number.isFinite(Number(cfg.weight_default)) ? Number(cfg.weight_default) : 1,
            _saved: false,
        };
    }

    async function loadConfig() {
        if (state.config) return state.config;

        try {
            const response = await fetch(`${BASE}/config`, {cache: "no-store"});
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || "Could not load Better Cards config");
            state.config = data;
        } catch (error) {
            console.warn("[ForgeBetterCards] Config unavailable", error);
            state.config = {
                weight_min: -4,
                weight_max: 4,
                weight_step: 0.05,
                weight_default: 1,
                auto_seed_from_cardmaster: true,
            };
        }

        return state.config;
    }

    async function loadIndex(force) {
        if (state.index && !force) return state.index;
        if (state.indexPromise && !force) return state.indexPromise;

        state.indexPromise = fetch(`${BASE}/index`, {cache: "no-store"})
            .then((response) => response.json())
            .then((data) => {
                if (!data.ok) throw new Error(data.error || "Could not load Better Cards index");
                state.index = data.cards || {};
                return state.index;
            })
            .catch((error) => {
                console.warn("[ForgeBetterCards] Index unavailable", error);
                state.index = {};
                return state.index;
            })
            .finally(() => {
                state.indexPromise = null;
            });

        return state.indexPromise;
    }

    function summarizeCard(card) {
        const set = selectedSet(card) || {};
        return {
            set_count: card && card.sets ? card.sets.length : 0,
            selected_set_id: card ? card.selected_set_id : "",
            selected_set_label: set.label || "",
            selected_image_url: set.image_url || "",
            updated_at: card ? card.updated_at : null,
            use_count: Number(card && card.use_count || 0),
            last_used: Number(card && card.last_used || 0),
            has_card_data: !!card,
        };
    }

    function rememberCard(identity, card) {
        if (!identity || !card) return;
        state.cards.set(identity.key, card);
        state.index = state.index || {};
        state.index[identity.key] = mergeUsageSummary(summarizeCard(card), state.index[identity.key]);
    }

    function mergeUsageSummary(summary, previous) {
        if (!previous) return summary;
        summary.use_count = Number(previous.use_count || summary.use_count || 0);
        summary.last_used = Number(previous.last_used || summary.last_used || 0);
        return summary;
    }

    function preloadImage(src) {
        if (!src || state.preloadedImages.has(src)) return;
        state.preloadedImages.add(src);
        const img = new Image();
        img.decoding = "async";
        img.src = src;
    }

    function preloadAdjacentImages(set) {
        if (!set || !Array.isArray(set.images) || set.images.length < 2) return;
        const run = () => {
            const index = Number(set.active_image_index || 0);
            preloadImage(set.images[(index + 1) % set.images.length]);
            preloadImage(set.images[(index - 1 + set.images.length) % set.images.length]);
        };
        if ("requestIdleCallback" in window) {
            requestIdleCallback(run, {timeout: 700});
        } else {
            setTimeout(run, 80);
        }
    }

    function setImageSrc(img, src) {
        if (!img) return;
        const nextSrc = src || "";
        const currentAttr = img.getAttribute("src") || "";
        if (currentAttr === nextSrc || img.src === nextSrc) return;
        if (!nextSrc) {
            img.removeAttribute("src");
            img.src = "";
            return;
        }
        img.src = nextSrc;
    }

    function setPreviewImage(preview, img, src) {
        if (!preview || !img) return;
        preview._fbcProgrammaticSrc = src || "";
        preview._fbcProgrammaticUntil = Date.now() + 350;
        setImageSrc(img, src);
        setTimeout(() => {
            if (preview._fbcProgrammaticUntil && Date.now() >= preview._fbcProgrammaticUntil) {
                preview._fbcProgrammaticSrc = "";
                preview._fbcProgrammaticUntil = 0;
            }
        }, 400);
    }

    function normalizeDroppedImageUrl(value) {
        const url = (value || "").trim();
        if (!url) return "";
        if (ROOT && url.startsWith(ROOT + "/")) return normalizeDroppedImageUrl(url.slice(ROOT.length));
        if (/^https?:\/\//i.test(url)) {
            try {
                const parsed = new URL(url);
                if (/\.(png|jpe?g|webp|gif)(?:$|[?#])/i.test(parsed.pathname)) return url;
                if (/\/sd_extra_networks\/thumb$/i.test(parsed.pathname) && parsed.searchParams.get("filename")) return url;
                if (/\/forge-better-cards\/image\/[^/?#]+\.(png|jpe?g|webp|gif)$/i.test(parsed.pathname)) return url;
            } catch (error) {
                return "";
            }
            return "";
        }
        if (/^\.?\/sd_extra_networks\/thumb\?/i.test(url)) return url;
        if (/^\/forge-better-cards\/image\/[^/?#]+\.(png|jpe?g|webp|gif)$/i.test(url)) return url;
        return "";
    }

    function isImageFile(file) {
        if (!file) return false;
        if (file.type && file.type.startsWith("image/")) return true;
        return /\.(png|jpe?g|webp|gif)$/i.test(file.name || "");
    }

    function extractDroppedImageUrl(event) {
        const transfer = event && event.dataTransfer;
        if (!transfer) return "";

        const uriList = transfer.getData("text/uri-list");
        if (uriList) {
            const url = uriList.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
            const normalized = normalizeDroppedImageUrl(url);
            if (normalized) return normalized;
        }

        const html = transfer.getData("text/html");
        if (html) {
            const match = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
            const normalized = normalizeDroppedImageUrl(match && match[1]);
            if (normalized) return normalized;
        }

        return normalizeDroppedImageUrl(transfer.getData("text/plain"));
    }

    function identityFromCard(card) {
        const container = card ? card.closest(".extra-network-cards[id]") : null;
        const match = container && container.id.match(/^(txt2img|img2img)_(.+)_cards$/);
        const tabname = match ? match[1] : getCurrentGenerationType();
        const page = match ? match[2] : "";
        const name = (card.getAttribute("data-name") || "").trim();
        const sortPath = card.dataset.sortPath || "";
        const sortName = card.dataset.sortName || name;
        const key = base64Url([page, sortPath, sortName, name].join("|"));

        return {key, tabname, page, name, sortPath, sortName, card};
    }

    function normalizeIdentityValue(value) {
        return String(value || "").replace(/\\/g, "/").toLowerCase();
    }

    function identityMatchesSummary(identity, summary, requirePath) {
        if (!identity || !summary) return false;
        const samePage =
            !summary.page ||
            !identity.page ||
            normalizeIdentityValue(summary.page) === normalizeIdentityValue(identity.page);
        const sameName =
            (!!identity.name && summary.name === identity.name) ||
            (!!identity.sortName && summary.sort_name === identity.sortName);
        if (!samePage || !sameName) return false;

        const identityPath = normalizeIdentityValue(identity.sortPath);
        const summaryPath = normalizeIdentityValue(summary.sort_path);
        if (identityPath && summaryPath) return identityPath === summaryPath;
        return !requirePath;
    }

    function sameIdentity(left, right) {
        if (!left || !right) return false;
        if (left.key && right.key && left.key === right.key) return true;

        const samePage = normalizeIdentityValue(left.page) === normalizeIdentityValue(right.page);
        const leftNames = [left.name, left.sortName].map(normalizeIdentityValue).filter(Boolean);
        const rightNames = [right.name, right.sortName].map(normalizeIdentityValue).filter(Boolean);
        const sameName = leftNames.some((name) => rightNames.includes(name));
        if (!samePage || !sameName) return false;

        const leftPath = normalizeIdentityValue(left.sortPath);
        const rightPath = normalizeIdentityValue(right.sortPath);
        if (leftPath && rightPath) return leftPath === rightPath;
        return true;
    }

    function resolveIdentity(identity) {
        if (!identity || !state.index) return identity;
        const current = state.index[identity.key];
        if (current && current.has_card_data) return identity;

        const entries = Object.entries(state.index);
        const exact = entries.find(([, summary]) => summary.has_card_data && identityMatchesSummary(identity, summary, true));
        const fallback = exact || entries.find(([, summary]) => summary.has_card_data && identityMatchesSummary(identity, summary, false));
        if (!fallback) return identity;

        return Object.assign({}, identity, {key: fallback[0]});
    }

    function getCurrentGenerationType() {
        const app = getApp();
        const txt2img = app.getElementById("tab_txt2img");
        return txt2img && txt2img.style.display === "block" ? "txt2img" : "img2img";
    }

    function promptTextarea(tabname, negative) {
        const id = negative ? `${tabname}_neg_prompt` : `${tabname}_prompt`;
        return getApp().querySelector(`#${id} > label > textarea`);
    }

    function cardQuery(identity) {
        const params = new URLSearchParams();
        params.set("key", identity.key || "");
        params.set("page", identity.page || "");
        params.set("sort_path", identity.sortPath || "");
        params.set("sort_name", identity.sortName || "");
        params.set("name", identity.name || "");
        return params.toString();
    }

    async function getCardData(identity) {
        await loadConfig();
        await loadIndex(false);
        identity = resolveIdentity(identity);
        if (state.cards.has(identity.key)) return state.cards.get(identity.key);
        if (state.loadingCards.has(identity.key)) return state.loadingCards.get(identity.key);
        const loadingKey = identity.key;

        const promise = (async () => {
            const response = await fetch(`${BASE}/card?${cardQuery(identity)}`, {cache: "no-store"});
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || "Could not load card data");
            if (data.key && data.key !== identity.key) {
                identity.key = data.key;
            }

            const card = Object.assign(defaultCard(identity), data.card || {});
            card._saved = !!data.found;
            card.sets = (card.sets || []).map((item) => normalizeSet(item, state.config));

            if (!card.sets.length && state.config.auto_seed_from_cardmaster) {
                const seeded = await seedFromCardMaster(identity);
                if (seeded.length) {
                    card.sets = seeded;
                    card.selected_set_id = seeded[0].id;
                }
            }

            if (!card.sets.length) {
                const preview = identity.card ? identity.card.querySelector("img.preview, img") : null;
                const set = normalizeSet({
                    label: "Set 1",
                    weight: card.weight_default,
                    image_url: preview ? preview.src : "",
                    images: preview && preview.src ? [preview.src] : [],
                }, state.config);
                card.sets = [set];
                card.selected_set_id = set.id;
            }

            if (!card.selected_set_id || !card.sets.some((set) => set.id === card.selected_set_id)) {
                card.selected_set_id = card.sets[0].id;
            }

            state.cards.set(identity.key, card);
            state.index = state.index || {};
            if (card._saved) state.index[identity.key] = summarizeCard(card);
            return card;
        })().finally(() => {
            state.loadingCards.delete(loadingKey);
        });

        state.loadingCards.set(loadingKey, promise);
        return promise;
    }

    async function seedFromCardMaster(identity) {
        if (!identity.card || !identity.sortPath || !identity.sortName) return [];

        const folder = btoa(encodeURIComponent(identity.sortPath));
        const name = btoa(encodeURIComponent(identity.sortName));
        const url = `${ROOT}/cardmaster/networkinfo/?network_folder=${enc(folder)}&network_name=${enc(name)}`;

        try {
            const response = await fetch(url, {cache: "no-store"});
            if (!response.ok) return [];
            const info = await response.json();
            const activationText = typeof info["activation text"] === "string" ? info["activation text"] : "";
            const negativePrompt = typeof info["negative prompt"] === "string" ? info["negative prompt"] : "";
            const notes = typeof info.notes === "string" ? info.notes : "";
            const preferredWeight = optionalNumber(info["preferred weight"]);
            const weight = Number.isFinite(preferredWeight) ? preferredWeight : 1;
            const sections = splitActivationSections(activationText);
            const preview = identity.card.querySelector("img.preview, img");
            return sections.map((section, index) => normalizeSet({
                label: `Set ${index + 1}`,
                activation_text: section,
                negative_prompt: negativePrompt,
                notes,
                weight,
                image_url: preview ? preview.src : "",
                images: preview && preview.src ? [preview.src] : [],
            }, state.config));
        } catch (error) {
            return [];
        }
    }

    function splitActivationSections(text) {
        const trimmed = (text || "").trim();
        if (!trimmed) return [];

        const explicit = trimmed.split(/(?:,,|;)\s*/).map((item) => item.trim()).filter(Boolean);
        if (explicit.length > 1) return explicit;

        const tags = splitTags(trimmed);
        if (tags.length < 2) return [trimmed];

        const first = tags[0];
        const sections = [[first]];
        for (let i = 1; i < tags.length; i++) {
            if (tags[i] === first) sections.push([]);
            sections[sections.length - 1].push(tags[i]);
        }

        return sections.map((section) => section.join(", ")).filter(Boolean);
    }

    function splitTags(text) {
        return (text || "")
            .split(/,(?![^(]*\))/)
            .map((item) => item.trim())
            .filter(Boolean);
    }

    function selectedSet(card) {
        if (!card || !card.sets || !card.sets.length) return null;
        return card.sets.find((item) => item.id === card.selected_set_id) || card.sets[0];
    }

    function selectedSetIndex(card) {
        const index = card.sets.findIndex((item) => item.id === card.selected_set_id);
        return index >= 0 ? index : 0;
    }

    function syncSelectedSetFromSurface(identity, surfaceCard, data) {
        if (!data || !Array.isArray(data.sets) || !data.sets.length) return;
        const visibleSetId = surfaceCard && surfaceCard.dataset ? surfaceCard.dataset.fbcSelectedSetId : "";
        const summary = state.index && identity ? state.index[identity.key] : null;
        const nextSetId = visibleSetId || (summary && summary.selected_set_id) || "";
        if (nextSetId && data.sets.some((set) => set.id === nextSetId)) {
            data.selected_set_id = nextSetId;
        }
    }

    function visibleCardsForIdentity(identity) {
        if (!identity) return [];
        const cards = Array.from(getApp().querySelectorAll(".extra-network-cards .card[data-name]"));
        return cards.filter((card) => {
            const other = resolveIdentity(identityFromCard(card));
            if (other.key === identity.key) return true;
            return identityMatchesSummary(other, {
                page: identity.page,
                name: identity.name,
                sort_name: identity.sortName,
                sort_path: identity.sortPath,
            }, false);
        });
    }

    function updateVisibleCardFronts(identity, data) {
        const cards = visibleCardsForIdentity(identity);
        if (!cards.length && identity && identity.card) {
            updateCardFront(identity.card, data);
            return;
        }

        cards.forEach((card) => {
            updateCardFront(card, data);
            const summary = state.index ? state.index[identity.key] : null;
            if (summary) {
                card.dataset.fbcProcessedMarker = [summary.set_count, summary.selected_set_id, summary.selected_set_label || "", summary.selected_image_url, summary.use_count || 0, summary.last_used || 0].join("|");
            } else {
                delete card.dataset.fbcProcessedMarker;
            }
        });
    }

    async function persistCardData(identity, card) {
        const payload = {
            key: identity.key,
            card: Object.assign({}, card, {
                page: identity.page,
                name: identity.name,
                sort_path: identity.sortPath,
                sort_name: identity.sortName,
            }),
        };

        const response = await fetch(`${BASE}/card`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not save Better Card data");

        const saved = Object.assign({}, data.card, {_saved: true});
        saved.sets = (saved.sets || []).map((item) => normalizeSet(item, state.config));
        return saved;
    }

    function saveCardData(identity, card) {
        const key = identity.key;
        const version = Number(state.saveVersions.get(key) || 0) + 1;
        const snapshot = cloneCard(card);
        state.saveVersions.set(key, version);

        const previous = state.saveChains.get(key) || Promise.resolve();
        const run = previous.catch(() => null).then(() => persistCardData(identity, snapshot));
        state.saveChains.set(key, run);
        run.then(() => {
            if (state.saveChains.get(key) === run) state.saveChains.delete(key);
        }, () => {
            if (state.saveChains.get(key) === run) state.saveChains.delete(key);
        });
        return run.then((saved) => ({saved, version}));
    }

    function applySavedCard(identity, card, saved, host, version) {
        if (version !== state.saveVersions.get(identity.key)) return false;
        Object.assign(card, saved);
        state.cards.set(identity.key, card);
        state.index = state.index || {};
        state.index[identity.key] = mergeUsageSummary(summarizeCard(card), state.index[identity.key]);
        updateVisibleCardFronts(identity, card);
        setStatus(host, "Saved.", false);
        return true;
    }

    function scheduleSave(identity, card, host) {
        clearTimeout(state.saveTimers.get(identity.key));
        const timer = setTimeout(async () => {
            try {
                const result = await saveCardData(identity, card);
                applySavedCard(identity, card, result.saved, host, result.version);
            } catch (error) {
                console.warn("[ForgeBetterCards] Autosave failed", error);
                setStatus(host, error.message || "Autosave failed.", true);
            }
        }, 700);
        state.saveTimers.set(identity.key, timer);
    }

    async function saveNow(identity, card, host) {
        clearTimeout(state.saveTimers.get(identity.key));
        try {
            const result = await saveCardData(identity, card);
            applySavedCard(identity, card, result.saved, host, result.version);
            return result.saved;
        } catch (error) {
            setStatus(host, error.message || "Save failed.", true);
            throw error;
        }
    }

    async function resetCardData(identity) {
        clearTimeout(state.saveTimers.get(identity.key));
        state.saveVersions.set(identity.key, Number(state.saveVersions.get(identity.key) || 0) + 1);

        const response = await fetch(`${BASE}/card`, {
            method: "DELETE",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                key: identity.key,
                page: identity.page,
                name: identity.name,
                sort_path: identity.sortPath,
                sort_name: identity.sortName,
            }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not reset Better Cards data");

        state.cards.delete(identity.key);
        state.index = state.index || {};
        delete state.index[identity.key];
        if (data.key && data.key !== identity.key) {
            state.cards.delete(data.key);
            delete state.index[data.key];
        }
        updateVisibleCardFronts(identity, null);
        await loadIndex(true);
        return getCardData(identity);
    }

    async function uploadImage(file) {
        const form = new FormData();
        form.append("image", file);

        const response = await fetch(`${BASE}/upload-image`, {
            method: "POST",
            body: form,
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "Could not upload image");
        return data.url;
    }

    function addImageToSet(set, url, makeActive) {
        if (!set || !url) return;
        set.images = Array.isArray(set.images) ? set.images.filter(Boolean) : [];
        if (!set.images.includes(url)) set.images.push(url);
        if (makeActive || !set.image_url) {
            set.active_image_index = Math.max(0, set.images.indexOf(url));
            set.image_url = url;
        }
    }

    function removeActiveImageFromSet(set) {
        if (!set || !Array.isArray(set.images) || !set.images.length) return "";
        const index = Math.max(0, Math.min(Number(set.active_image_index || 0), set.images.length - 1));
        const removed = set.images.splice(index, 1)[0] || "";
        if (set.images.length) {
            const nextIndex = Math.min(index, set.images.length - 1);
            set.active_image_index = nextIndex;
            set.image_url = set.images[nextIndex] || "";
        } else {
            set.active_image_index = 0;
            set.image_url = "";
        }
        return removed;
    }

    function setActiveImage(set, index) {
        if (!set || !Array.isArray(set.images) || !set.images.length) return;
        const nextIndex = (index + set.images.length) % set.images.length;
        set.active_image_index = nextIndex;
        set.image_url = set.images[nextIndex];
    }

    function findCardForEditor(editor) {
        const match = (editor.id || "").match(/^(txt2img|img2img)_(.+)_edit_user_metadata$/);
        if (!match) return null;

        const tabname = match[1];
        const page = match[2];
        const inputWrap = getApp().getElementById(`${editor.id}_name`);
        const textarea = inputWrap ? inputWrap.querySelector("textarea") : null;
        const name = textarea ? textarea.value : "";
        const container = getApp().getElementById(`${tabname}_${page}_cards`);
        if (!container || !name) return null;

        return container.querySelector(`.card[data-name="${escapeAttributeValue(name)}"]`);
    }

    function currentEditorIdentity(editor) {
        const card = findCardForEditor(editor);
        return card ? identityFromCard(card) : null;
    }

    function editorContextIsCurrent(editor, context) {
        return !!(context && sameIdentity(currentEditorIdentity(editor), context.identity));
    }

    function labelText(label) {
        if (label.dataset.fbcLabelText) return label.dataset.fbcLabelText;
        const clone = label.cloneNode(true);
        clone.querySelectorAll("input, textarea, select, button").forEach((node) => node.remove());
        const text = clone.textContent.replace(/\s+/g, " ").trim().toLowerCase();
        label.dataset.fbcLabelText = text;
        return text;
    }

    function findField(editor, names, selector) {
        const lowered = names.map((name) => name.toLowerCase());
        const labels = Array.from(editor.querySelectorAll("label"));
        for (const label of labels) {
            const text = labelText(label);
            if (!lowered.some((name) => text.includes(name))) continue;
            const field = label.querySelector(selector);
            if (field) return field;
        }
        return null;
    }

    function editorPageName(editor) {
        const match = (editor && editor.id || "").match(/^(txt2img|img2img)_(.+)_edit_user_metadata$/);
        return match ? match[2] : "";
    }

    function editorSupportsPromptFields(editor) {
        const page = editorPageName(editor);
        return page === "lora" || page === "lycoris";
    }

    function getEditorControls(editor) {
        const cached = editor._fbcControlsCache;
        if (cached && Object.values(cached).every((node) => !node || node.isConnected)) {
            return cached;
        }

        if (!editorSupportsPromptFields(editor)) {
            editor._fbcControlsCache = {
                activation: null,
                negative: null,
                notes: null,
                description: findField(editor, ["description"], "textarea"),
                weightNumber: null,
                weightRange: null,
            };
            return editor._fbcControlsCache;
        }

        editor._fbcControlsCache = {
            activation: findField(editor, ["activation text"], "textarea, input[type='text']"),
            negative: findField(editor, ["negative prompt"], "textarea, input[type='text']"),
            notes: findField(editor, ["notes"], "textarea, input[type='text']"),
            description: findField(editor, ["description"], "textarea"),
            weightNumber: findField(editor, ["preferred weight"], "input[type='number']"),
            weightRange: findField(editor, ["preferred weight"], "input[type='range']"),
        };
        return editor._fbcControlsCache;
    }

    function setFieldValue(field, value) {
        if (!field) return;
        const nextValue = value == null ? "" : String(value);
        if (field.value === nextValue) return;
        field.value = nextValue;
        updateInput(field);
    }

    function collectEditorSet(editor, card) {
        const set = selectedSet(card);
        if (!set || editor.dataset.fbcHydrating === "true") return;

        const controls = getEditorControls(editor);
        if (controls.activation) set.activation_text = controls.activation.value || "";
        if (controls.negative) set.negative_prompt = controls.negative.value || "";
        if (controls.notes) set.notes = controls.notes.value || "";

        const weightSource = controls.weightNumber || controls.weightRange;
        const weight = Number(weightSource ? weightSource.value : set.weight);
        if (Number.isFinite(weight)) set.weight = weight;
    }

    function editorWeightValue(editor, fallback) {
        const controls = getEditorControls(editor);
        const source = controls.weightNumber || controls.weightRange;
        const value = optionalNumber(source ? source.value : null);
        return Number.isFinite(value) ? value : fallback;
    }

    function initializeUnsavedSetFromEditor(editor, card) {
        if (!card || card._saved) return;
        const set = selectedSet(card);
        if (!set) return;

        const controls = getEditorControls(editor);
        if (!set.activation_text && controls.activation) set.activation_text = controls.activation.value || "";
        if (!set.negative_prompt && controls.negative) set.negative_prompt = controls.negative.value || "";
        if (!set.notes && controls.notes) set.notes = controls.notes.value || "";

        const weightSource = controls.weightNumber || controls.weightRange;
        const weight = Number(weightSource ? weightSource.value : set.weight);
        if (Number.isFinite(weight)) set.weight = weight;

        if (!set.image_url) {
            const src = editorPreviewSource(editor);
            if (src) addImageToSet(set, src, true);
        }
    }

    function metadataScrollElement(editor) {
        return editor && editor.closest(".global-popup-inner");
    }

    function restoreMetadataScroll(inner, top) {
        if (!inner || top <= 0) return;
        requestAnimationFrame(() => {
            const maxScroll = Math.max(0, inner.scrollHeight - inner.clientHeight);
            const nextTop = Math.min(top, maxScroll);
            if (nextTop > 0 && inner.scrollTop < nextTop - 4) {
                inner.scrollTop = nextTop;
            }
        });
    }

    function preserveMetadataScroll(editor, callback) {
        const inner = metadataScrollElement(editor);
        const top = inner ? inner.scrollTop : 0;
        callback();
        restoreMetadataScroll(inner, top);
    }

    function hydrateEditorSet(editor, card) {
        const set = selectedSet(card);
        if (!set) return;

        const controls = getEditorControls(editor);
        editor.dataset.fbcHydrating = "true";
        preserveMetadataScroll(editor, () => {
            setFieldValue(controls.activation, set.activation_text);
            setFieldValue(controls.negative, set.negative_prompt);
            setFieldValue(controls.notes, set.notes);
            setFieldValue(controls.weightNumber, set.weight);
            setFieldValue(controls.weightRange, set.weight);
            configureWeightRange(controls, card);
            updateEditorPreview(editor, set);
        });
        setTimeout(() => {
            editor.dataset.fbcHydrating = "false";
        }, 0);
    }

    function editorFieldMismatch(editor, card) {
        const set = selectedSet(card);
        if (!set) return false;
        const controls = getEditorControls(editor);
        const active = document.activeElement;
        const controlled = [controls.activation, controls.negative, controls.notes, controls.weightNumber, controls.weightRange].filter(Boolean);
        if (controlled.includes(active)) return false;

        const expectedWeight = Number(set.weight);
        const numberMismatch = controls.weightNumber && Number(controls.weightNumber.value) !== expectedWeight;
        const rangeMismatch = controls.weightRange && Number(controls.weightRange.value) !== expectedWeight;

        return (
            (controls.activation && controls.activation.value !== (set.activation_text || "")) ||
            (controls.negative && controls.negative.value !== (set.negative_prompt || "")) ||
            (controls.notes && controls.notes.value !== (set.notes || "")) ||
            numberMismatch ||
            rangeMismatch
        );
    }

    function configureWeightRange(controls, card) {
        [controls.weightNumber, controls.weightRange].forEach((field) => {
            if (!field) return;
            field.min = String(card.weight_min);
            field.max = String(card.weight_max);
            field.step = String(card.weight_step);
        });
    }

    function updateEditorPreview(editor, set) {
        const preview = editor.querySelector(".standalone-card-preview");
        if (!preview) return;

        preview.classList.add("fbc-preview-drop");
        let img = preview.querySelector("img.preview, img");
        if (!img) {
            img = document.createElement("img");
            img.className = "preview";
            img.alt = "";
            img.decoding = "async";
            preview.appendChild(img);
        }

        const nextSrc = set.image_url || "";
        setPreviewImage(preview, img, nextSrc);
        const hasImage = nextSrc ? "true" : "false";
        if (preview.dataset.hasImage !== hasImage) preview.dataset.hasImage = hasImage;
        if (!preview.querySelector(".fbc-preview-placeholder")) {
            const placeholder = document.createElement("div");
            placeholder.className = "fbc-preview-placeholder";
            placeholder.textContent = "Click or drop image";
            preview.appendChild(placeholder);
        }
    }

    function editorPreviewSource(editor) {
        const img = editor.querySelector(".standalone-card-preview img.preview, .standalone-card-preview img");
        return img ? (img.getAttribute("src") || "") : "";
    }

    function makeButton(text, title) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = text;
        btn.title = title || text;
        return btn;
    }

    function makeIconButton(svg, title) {
        const btn = makeButton("", title);
        btn.innerHTML = svg;
        btn.setAttribute("aria-label", title);
        return btn;
    }

    function setStatus(host, text, isError) {
        const status = host && host.querySelector(".fbc-status");
        if (!status) return;
        status.textContent = text || "";
        status.dataset.error = isError ? "true" : "false";
    }

    async function runEditorAction(host, action) {
        if (!host || host.dataset.fbcActionBusy === "true") return null;
        host.dataset.fbcActionBusy = "true";
        try {
            return await action();
        } finally {
            host.dataset.fbcActionBusy = "false";
        }
    }

    async function saveEditorCard(editor, host, message) {
        const context = host && host._fbcContext;
        if (!context) return null;
        if (!editorContextIsCurrent(editor, context)) return null;
        collectEditorSet(editor, context.card);
        setStatus(host, message || "Saving set...", false);
        return saveNow(context.identity, context.card, host);
    }

    function renderPager(host, editor, identity, card) {
        preserveMetadataScroll(editor, () => {
            const contextCard = () => (host && host._fbcContext && host._fbcContext.card) || card;
            host.innerHTML = "";

            const pages = document.createElement("div");
            pages.className = "fbc-pages";
            host.appendChild(pages);

            if (contextCard().sets.length > 1) {
                contextCard().sets.forEach((set, index) => {
                    const btn = makeButton(String(index + 1), `Set ${index + 1}`);
                    btn.className = "fbc-page-btn";
                    btn.setAttribute("aria-pressed", set.id === contextCard().selected_set_id ? "true" : "false");
                    btn.addEventListener("click", async () => {
                        await runEditorAction(host, async () => {
                            const activeCard = contextCard();
                            const target = activeCard.sets.find((item) => item.id === set.id);
                            if (!target || target.id === activeCard.selected_set_id) return;
                            collectEditorSet(editor, activeCard);
                            activeCard.selected_set_id = target.id;
                            hydrateEditorSet(editor, activeCard);
                            renderPager(host, editor, identity, activeCard);
                            host.dataset.renderedSetId = target.id;
                            host.dataset.renderedSetCount = String(activeCard.sets.length);
                            rememberCard(identity, activeCard);
                            await saveNow(identity, activeCard, host);
                        });
                    });
                    pages.appendChild(btn);
                });
            }

        const add = makeButton("+", "Create new set");
        add.className = "fbc-page-btn fbc-add-page";
        add.addEventListener("click", async () => {
            await runEditorAction(host, async () => {
                const activeCard = contextCard();
                collectEditorSet(editor, activeCard);
                const current = selectedSet(activeCard);
                const fallbackWeight = current && Number.isFinite(Number(current.weight)) ? Number(current.weight) : activeCard.weight_default;
                const set = normalizeSet({
                    label: `Set ${activeCard.sets.length + 1}`,
                    activation_text: "",
                    negative_prompt: "",
                    notes: "",
                    weight: editorWeightValue(editor, fallbackWeight),
                    image_url: "",
                }, state.config);
                    activeCard.sets.push(set);
                    activeCard.selected_set_id = set.id;
                    hydrateEditorSet(editor, activeCard);
                    renderPager(host, editor, identity, activeCard);
                    host.dataset.renderedSetId = set.id;
                    host.dataset.renderedSetCount = String(activeCard.sets.length);
                    rememberCard(identity, activeCard);
                    await saveNow(identity, activeCard, host);
                });
            });
            pages.appendChild(add);

            const tools = document.createElement("div");
            tools.className = "fbc-set-tools";
            const activeSet = selectedSet(contextCard());
            const activeIndex = selectedSetIndex(contextCard());
            const name = makeButton((activeSet && activeSet.label) || `Set ${activeIndex + 1}`, "Rename set nickname");
            name.className = "fbc-set-name";
            name.addEventListener("click", async () => {
                if (host.dataset.fbcActionBusy === "true") return;
                const previewCard = contextCard();
                const previewSet = selectedSet(previewCard);
                if (!previewSet) return;
                const currentLabel = previewSet.label || `Set ${selectedSetIndex(previewCard) + 1}`;
                const nextLabel = window.prompt("Set nickname", currentLabel);
                if (nextLabel == null) return;
                await runEditorAction(host, async () => {
                const activeCard = contextCard();
                const set = selectedSet(activeCard);
                if (!set) return;
                const trimmed = nextLabel.trim();
                if (!trimmed || trimmed === set.label) return;
                collectEditorSet(editor, activeCard);
                set.label = trimmed;
                renderPager(host, editor, identity, activeCard);
                updateVisibleCardFronts(identity, activeCard);
                rememberCard(identity, activeCard);
                await saveNow(identity, activeCard, host);
                });
            });

            const removeSet = makeIconButton('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>', "Delete current set");
            removeSet.className = "fbc-delete-set";
            removeSet.disabled = contextCard().sets.length < 2;
            removeSet.addEventListener("click", async () => {
                if (host.dataset.fbcActionBusy === "true") return;
                const previewCard = contextCard();
                if (!previewCard.sets || previewCard.sets.length < 2) return;
                const previewIndex = selectedSetIndex(previewCard);
                const previewSet = selectedSet(previewCard);
                const label = (previewSet && previewSet.label) || `Set ${previewIndex + 1}`;
                if (!window.confirm(`Delete ${label}?`)) return;
                await runEditorAction(host, async () => {
                const activeCard = contextCard();
                if (!activeCard.sets || activeCard.sets.length < 2) return;
                const selectedId = activeCard.selected_set_id;
                const index = activeCard.sets.findIndex((item) => item.id === selectedId);
                if (index < 0) return;
                activeCard.sets.splice(index, 1);
                const next = activeCard.sets[Math.max(0, Math.min(index, activeCard.sets.length - 1))];
                activeCard.selected_set_id = next ? next.id : "";
                hydrateEditorSet(editor, activeCard);
                renderPager(host, editor, identity, activeCard);
                host.dataset.renderedSetId = activeCard.selected_set_id;
                host.dataset.renderedSetCount = String(activeCard.sets.length);
                updateVisibleCardFronts(identity, activeCard);
                rememberCard(identity, activeCard);
                await saveNow(identity, activeCard, host);
                });
            });
            const resetCard = makeIconButton('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5v6h6"/><path d="M20 19v-6h-6"/><path d="M6.5 9a7 7 0 0 1 11.7-2.5L20 8"/><path d="M17.5 15a7 7 0 0 1-11.7 2.5L4 16"/></svg>', "Reset Better Cards data");
            resetCard.className = "fbc-reset-card";
            resetCard.addEventListener("click", async () => {
                if (host.dataset.fbcActionBusy === "true") return;
                if (!window.confirm("Reset Better Cards data for this card? This removes saved sets, nicknames, and uploaded image links added by this extension.")) return;
                try {
                    await runEditorAction(host, async () => {
                        setStatus(host, "Resetting Better Cards...", false);
                        const fresh = await resetCardData(identity);
                        host._fbcContext.card = fresh;
                        initializeUnsavedSetFromEditor(editor, fresh);
                        renderPager(host, editor, identity, fresh);
                        hydrateEditorSet(editor, fresh);
                        updateVisibleCardFronts(identity, fresh);
                        setStatus(host, "Reset.", false);
                    });
                } catch (error) {
                    setStatus(host, error.message || "Reset failed.", true);
                }
            });
            const saveSet = makeIconButton('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h13l1 1v17H5z"/><path d="M8 3v6h10"/><path d="M8 21v-7h8v7"/></svg>', "Save Better Cards set");
            saveSet.className = "fbc-save-set";
            saveSet.addEventListener("click", async () => {
                try {
                    await runEditorAction(host, () => saveEditorCard(editor, host, "Saving set..."));
                } catch (error) {
                    setStatus(host, error.message || "Save set failed.", true);
                }
            });
            tools.append(name, saveSet, removeSet, resetCard);
            host.appendChild(tools);

            const status = document.createElement("span");
            status.className = "fbc-status";
            host.appendChild(status);
        });
    }

    function attachEditorListeners(editor, host) {
        if (editor.dataset.fbcListenersReady === "true") return;
        editor.dataset.fbcListenersReady = "true";

        editor.addEventListener("input", (event) => {
            if (editor.dataset.fbcHydrating === "true") return;
            if (!event.target.matches("textarea, input")) return;
            const context = host._fbcContext;
            if (!context) return;
            if (!editorContextIsCurrent(editor, context)) return;

            const controls = getEditorControls(editor);
            const controlled = [
                controls.activation,
                controls.negative,
                controls.notes,
                controls.weightNumber,
                controls.weightRange,
            ].includes(event.target);
            if (!controlled) return;

            collectEditorSet(editor, context.card);
            rememberCard(context.identity, context.card);
            updateVisibleCardFronts(context.identity, context.card);
            scheduleSave(context.identity, context.card, host);
        }, true);

        editor.addEventListener("change", (event) => {
            if (editor.dataset.fbcHydrating === "true") return;
            if (!event.target.matches("textarea, input")) return;
            const context = host._fbcContext;
            if (!context) return;
            if (!editorContextIsCurrent(editor, context)) return;
            collectEditorSet(editor, context.card);
            rememberCard(context.identity, context.card);
            updateVisibleCardFronts(context.identity, context.card);
            scheduleSave(context.identity, context.card, host);
        }, true);
    }

    function attachPreviewUpload(editor, host) {
        const preview = editor.querySelector(".standalone-card-preview");
        if (!preview || preview.dataset.fbcUploadReady === "true") return;
        preview.dataset.fbcUploadReady = "true";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/png,image/jpeg,image/webp,image/gif";
        fileInput.className = "fbc-hidden-file";
        preview.appendChild(fileInput);

        const removeButton = makeButton("x", "Remove current image");
        removeButton.className = "fbc-preview-remove";
        preview.appendChild(removeButton);

        async function saveImageUrlToActiveSet(url) {
            const context = host._fbcContext;
            if (!context) return;
            if (!editorContextIsCurrent(editor, context)) return;
            const set = selectedSet(context.card);
            addImageToSet(set, url, true);
            updateEditorPreview(editor, set);
            updateVisibleCardFronts(context.identity, context.card);
            rememberCard(context.identity, context.card);
            await saveNow(context.identity, context.card, host);
        }

        async function handleImageUrl(url) {
            try {
                await runEditorAction(host, () => saveImageUrlToActiveSet(url));
            } catch (error) {
                setStatus(host, error.message || "Image save failed.", true);
            }
        }

        async function handleFile(file) {
            if (!file) return;
            try {
                await runEditorAction(host, async () => {
                    setStatus(host, "Uploading image...", false);
                    const url = await uploadImage(file);
                    await saveImageUrlToActiveSet(url);
                });
            } catch (error) {
                setStatus(host, error.message || "Upload failed.", true);
            }
        }

        preview.addEventListener("click", (event) => {
            if (event.target.closest(".fbc-hidden-file")) return;
            if (event.target.closest(".fbc-preview-remove")) return;
            const context = host._fbcContext;
            if (!editorContextIsCurrent(editor, context)) return;
            const set = context ? selectedSet(context.card) : null;
            if (set && set.image_url) {
                openLightbox(set.image_url, {editor, host, identity: context.identity, card: context.card, set});
            } else {
                fileInput.click();
            }
            event.stopPropagation();
        });

        removeButton.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const context = host._fbcContext;
            if (!editorContextIsCurrent(editor, context)) return;
            const set = context ? selectedSet(context.card) : null;
            if (!context || !set || !Array.isArray(set.images) || !set.images.length) return;
            if (!window.confirm("Remove this image from this set?")) return;
            try {
                await runEditorAction(host, async () => {
                    removeActiveImageFromSet(set);
                    updateEditorPreview(editor, set);
                    updateVisibleCardFronts(context.identity, context.card);
                    rememberCard(context.identity, context.card);
                    await saveNow(context.identity, context.card, host);
                });
            } catch (error) {
                setStatus(host, error.message || "Image remove failed.", true);
            }
        });

        preview.addEventListener("dragover", (event) => {
            event.preventDefault();
            preview.classList.add("fbc-drag-over");
        });
        preview.addEventListener("dragleave", () => preview.classList.remove("fbc-drag-over"));
        preview.addEventListener("drop", (event) => {
            event.preventDefault();
            preview.classList.remove("fbc-drag-over");
            const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
            if (file) {
                if (isImageFile(file)) handleFile(file);
                else setStatus(host, "Drop an image file.", true);
            } else {
                const url = extractDroppedImageUrl(event);
                if (url) handleImageUrl(url);
                else setStatus(host, "Drop an image file or direct image URL.", true);
            }
        });
        fileInput.addEventListener("change", () => {
            const file = fileInput.files && fileInput.files[0];
            if (file && isImageFile(file)) handleFile(file);
            else if (file) setStatus(host, "Choose an image file.", true);
            fileInput.value = "";
        });

    }

    function attachNativeSaveBridge(editor, host) {
        if (editor.dataset.fbcNativeSaveReady === "true") return;
        editor.dataset.fbcNativeSaveReady = "true";
        editor.addEventListener("click", (event) => {
            const button = event.target.closest("button");
            if (!button || !button.closest(".edit-user-metadata-buttons")) return;
            if ((button.textContent || "").trim().toLowerCase() !== "save") return;
            saveEditorCard(editor, host, "Saving Better Cards...").catch((error) => {
                console.warn("[ForgeBetterCards] Native save bridge failed", error);
                setStatus(host, error.message || "Better Cards save failed.", true);
            });
        }, true);
    }

    async function injectEditorPages() {
        await loadConfig();
        await loadIndex(false);

        getApp().querySelectorAll(".edit-user-metadata").forEach(async (editor) => {
            const cardElement = findCardForEditor(editor);
            if (!cardElement) return;

            const identity = resolveIdentity(identityFromCard(cardElement));
            let host = editor.querySelector(".fbc-page-host");
            if (!host) {
                host = document.createElement("div");
                host.className = "fbc-page-host";
                const title = editor.querySelector(".extra-network-name");
                if (title) {
                    title.insertAdjacentElement("afterend", host);
                } else {
                    editor.insertAdjacentElement("afterbegin", host);
                }
            }

            const previousCardKey = host.dataset.cardKey || "";
            const switchedCard = previousCardKey && previousCardKey !== identity.key;
            if (host.dataset.cardKey !== identity.key) {
                host.dataset.cardKey = identity.key;
                if (switchedCard) host.dataset.fbcSkipEditorSeedKey = identity.key;
                host.innerHTML = "<span class='fbc-status'>Loading sets...</span>";
            }

            try {
                const card = await getCardData(identity);
                if (host.dataset.cardKey !== identity.key || !sameIdentity(currentEditorIdentity(editor), identity)) return;
                if (host.dataset.fbcSkipEditorSeedKey === identity.key) {
                    delete host.dataset.fbcSkipEditorSeedKey;
                } else {
                    initializeUnsavedSetFromEditor(editor, card);
                }
                host._fbcContext = {identity, card};
                attachEditorListeners(editor, host);
                attachPreviewUpload(editor, host);
                attachNativeSaveBridge(editor, host);

                const set = selectedSet(card);
                const activeSetId = set ? set.id : "";
                const shouldHydrate =
                    host.dataset.renderedCardKey !== identity.key ||
                    host.dataset.renderedSetId !== activeSetId ||
                    host.dataset.renderedSetCount !== String(card.sets.length) ||
                    editorFieldMismatch(editor, card);
                const canDeferHydrate =
                    host.dataset.renderedCardKey === identity.key &&
                    Date.now() < state.metadataScrollLockUntil;

                if (shouldHydrate && !canDeferHydrate) {
                    renderPager(host, editor, identity, card);
                    hydrateEditorSet(editor, card);
                    host.dataset.renderedCardKey = identity.key;
                    host.dataset.renderedSetId = activeSetId;
                    host.dataset.renderedSetCount = String(card.sets.length);
                }
            } catch (error) {
                if (host.dataset.cardKey === identity.key) {
                    host.innerHTML = `<span class="fbc-error">Better Cards failed: ${error.message || error}</span>`;
                }
            }
        });
    }

    async function injectCardNavigation() {
        await loadConfig();
        await loadIndex(false);

        setupSetToggles();
        observeCards(getApp().querySelectorAll(".extra-network-cards .card[data-name]"));
    }

    function observeCards(cards) {
        const token = ++state.cardBatchToken;
        let index = 0;
        const run = (deadline) => {
            if (token !== state.cardBatchToken) return;
            let processed = 0;
            while (index < cards.length && (processed < 40 || (deadline && deadline.timeRemaining() > 4))) {
                const card = cards[index++];
                processed++;
                if (!card || !card.isConnected) continue;
                if (card.matches('[data-no-favorite="true"], [data-no-better-card="true"], .forge-prompt-sets-add-card')) continue;
                observeCard(card);
            }
            if (index < cards.length) {
                if ("requestIdleCallback" in window) {
                    requestIdleCallback(run, {timeout: 300});
                } else {
                    setTimeout(() => run(null), 16);
                }
            }
        };

        if ("requestIdleCallback" in window) {
            requestIdleCallback(run, {timeout: 120});
        } else {
            setTimeout(() => run(null), 0);
        }
    }

    function observeCard(card) {
        if (state.observedCards.has(card)) {
            if (isCardNearViewport(card)) processCard(card);
            return;
        }
        state.observedCards.add(card);

        if (card.dataset.fbcClickReady !== "true") {
            card.dataset.fbcClickReady = "true";
            card.addEventListener("click", handleBetterCardClick, true);
        }

        if (!state.cardObserver && "IntersectionObserver" in window) {
            state.cardObserver = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) processCard(entry.target);
                });
            }, {root: null, rootMargin: "600px 0px"});
        }

        if (state.cardObserver) {
            state.cardObserver.observe(card);
            if (isCardNearViewport(card)) processCard(card);
        } else {
            processCard(card);
        }
    }

    function isCardNearViewport(card) {
        if (!card || typeof card.getBoundingClientRect !== "function") return false;
        const rect = card.getBoundingClientRect();
        const margin = 600;
        const height = window.innerHeight || document.documentElement.clientHeight || 0;
        const width = window.innerWidth || document.documentElement.clientWidth || 0;
        return rect.bottom >= -margin && rect.top <= height + margin && rect.right >= -margin && rect.left <= width + margin;
    }

    function processCard(card) {
        const identity = resolveIdentity(identityFromCard(card));
        const summary = state.index ? state.index[identity.key] : null;
        const marker = summary
            ? [summary.set_count, summary.selected_set_id, summary.selected_set_label || "", summary.selected_image_url, summary.use_count || 0, summary.last_used || 0].join("|")
            : "none";
        const expectsNav = summary && Number(summary.set_count || 0) > 1;
        const hasNav = !!card.querySelector(".fbc-card-nav");
        if (card.dataset.fbcProcessedMarker === marker && (!expectsNav || hasNav)) return;
        card.dataset.fbcProcessedMarker = marker;
        updateCardFront(card, summary);
        if (!summary || !summary.has_card_data) {
            hydrateCardFrontFromBackend(card, identity);
        }
    }

    async function hydrateCardFrontFromBackend(card, identity) {
        if (!card || card.dataset.fbcLookupPending === "true") return;
        card.dataset.fbcLookupPending = "true";
        try {
            const data = await getCardData(identity);
            if (!data || !data._saved) return;
            rememberCard(identity, data);
            updateCardFront(card, data);
            const summary = state.index ? state.index[identity.key] : null;
            if (summary) {
                card.dataset.fbcProcessedMarker = [summary.set_count, summary.selected_set_id, summary.selected_set_label || "", summary.selected_image_url, summary.use_count || 0, summary.last_used || 0].join("|");
            }
        } catch (error) {
            console.warn("[ForgeBetterCards] Card lookup failed", error);
        } finally {
            delete card.dataset.fbcLookupPending;
        }
    }

    function ensureCardNav(card) {
        let nav = card.querySelector(".fbc-card-nav");
        if (nav) return nav;

        card.style.position = card.style.position || "relative";
        nav = document.createElement("div");
        nav.className = "fbc-card-nav";
        const prev = makeButton("<", "Previous set");
        const next = makeButton(">", "Next set");
        prev.className = "fbc-card-arrow fbc-card-prev";
        next.className = "fbc-card-arrow fbc-card-next";
        nav.append(prev, next);
        card.appendChild(nav);

        prev.addEventListener("click", (event) => switchCardSet(event, card, -1));
        next.addEventListener("click", (event) => switchCardSet(event, card, 1));
        return nav;
    }

    function removeCardNav(card) {
        const nav = card.querySelector(".fbc-card-nav");
        if (nav) nav.remove();
        card.removeAttribute("data-fbc-has-pages");
    }

    function updateCardSetLabel(card, label, setCount) {
        let badge = card.querySelector(".fbc-card-set-label");
        const text = setCount > 1 ? (label || "") : "";
        if (!text) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement("div");
            badge.className = "fbc-card-set-label";
            card.appendChild(badge);
        }
        badge.textContent = text;
    }

    function updateCardFront(card, data) {
        if (!card) return;
        if (!data) {
            removeCardNav(card);
            updateCardSetLabel(card, "", 0);
            delete card.dataset.fbcSelectedSetId;
            return;
        }

        const setCount = data.sets ? data.sets.length : Number(data.set_count || 0);
        if (setCount > 1) {
            ensureCardNav(card);
            card.dataset.fbcHasPages = "true";
        } else {
            removeCardNav(card);
        }

        const img = card.querySelector("img.preview, img");
        if (!img) return;
        if (img.dataset.fbcPerfReady !== "true") {
            img.dataset.fbcPerfReady = "true";
            img.decoding = "async";
            img.loading = img.loading || "lazy";
        }
        if (!card.dataset.fbcOriginalPreview) {
            card.dataset.fbcOriginalPreview = img.src || "";
        }

        const set = data.sets ? selectedSet(data) : null;
        const selectedSetId = (set && set.id) || data.selected_set_id || "";
        if (selectedSetId) {
            card.dataset.fbcSelectedSetId = selectedSetId;
        } else {
            delete card.dataset.fbcSelectedSetId;
        }
        updateCardSetLabel(card, (set && set.label) || data.selected_set_label || "", setCount);
        const nextSrc = (set && set.image_url) || data.selected_image_url || card.dataset.fbcOriginalPreview;
        if (nextSrc) setImageSrc(img, nextSrc);
        if (set) preloadAdjacentImages(set);
    }

    async function switchCardSet(event, card, delta) {
        event.preventDefault();
        event.stopPropagation();
        if (card.dataset.fbcSwitchBusy === "true") return;
        card.dataset.fbcSwitchBusy = "true";

        try {
            const identity = resolveIdentity(identityFromCard(card));
            const data = await getCardData(identity);
            if (!data.sets || data.sets.length < 2) return;

            const index = selectedSetIndex(data);
            const nextIndex = (index + delta + data.sets.length) % data.sets.length;
            data.selected_set_id = data.sets[nextIndex].id;
            rememberCard(identity, data);
            updateCardFront(card, data);
            await saveNow(identity, data, null);
        } finally {
            card.dataset.fbcSwitchBusy = "false";
        }
    }

    async function handleBetterCardClick(event) {
        if (event.target.closest(".fbc-card-nav, .fbc-card-arrow, .fmb-model-badge, .fmb-type-menu")) return;
        if (event.target.closest("button, a, input, textarea, select, label, .button-row, .metadata-button, .edit-button, .copy-path-button")) return;
        const card = event.currentTarget;
        const identity = resolveIdentity(identityFromCard(card));
        const summary = state.index ? state.index[identity.key] : null;
        if (!summary || !summary.has_card_data) {
            recordUsage(identity);
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        try {
            const data = await getCardData(identity);
            syncSelectedSetFromSurface(identity, card, data);
            const set = selectedSet(data);
            if (set) {
                applySetToPrompt(identity, data, set);
                recordUsage(identity);
            }
        } catch (error) {
            console.warn("[ForgeBetterCards] Failed to apply set", error);
        }
    }

    function recordUsage(identity) {
        if (!identity || !identity.key) return;
        const now = Date.now();
        state.index = state.index || {};
        const summary = state.index[identity.key] || {
            set_count: 0,
            selected_set_id: "",
            selected_image_url: "",
            updated_at: null,
            has_card_data: false,
        };
        summary.use_count = Number(summary.use_count || 0) + 1;
        summary.last_used = now;
        state.index[identity.key] = summary;

        const body = JSON.stringify({key: identity.key});
        if (navigator.sendBeacon) {
            navigator.sendBeacon(`${BASE}/usage`, new Blob([body], {type: "application/json"}));
        } else {
            fetch(`${BASE}/usage`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body,
                keepalive: true,
            }).catch((error) => console.warn("[ForgeBetterCards] Usage save failed", error));
        }

    }

    function promptTrackerKey(tabname, negative, identity) {
        return `${tabname}:${negative ? "neg" : "pos"}:${identity.key}`;
    }

    function buildSetPromptTokens(identity, set) {
        const tokens = [];
        if (identity.page === "lora" || identity.page === "lycoris") {
            const weight = Number.isFinite(Number(set.weight)) ? Number(set.weight) : 1;
            tokens.push(`<lora:${identity.name}:${weight}>`);
        }
        splitTags(set.activation_text).forEach((tag) => tokens.push(tag));
        return tokens;
    }

    function tokenMatchesPromptPart(part, token, identity) {
        const trimmed = (part || "").trim();
        const wanted = (token || "").trim();
        if (!trimmed || !wanted) return false;
        if (/^<lora:/i.test(wanted) && (identity.page === "lora" || identity.page === "lycoris")) {
            return new RegExp(`^<lora:${escapeRegExp(identity.name)}:[^>]+>$`, "i").test(trimmed);
        }
        return trimmed.toLowerCase() === wanted.toLowerCase();
    }

    function promptContainsTokens(text, tokens, identity) {
        if (!tokens.length) return false;
        const parts = splitTags(text);
        return tokens.every((token) => parts.some((part) => tokenMatchesPromptPart(part, token, identity)));
    }

    function samePromptTokens(left, right) {
        if (left.length !== right.length) return false;
        return left.every((token, index) => token === right[index]);
    }

    function promptInsertionTokens(record) {
        if (Array.isArray(record)) return record;
        if (record && Array.isArray(record.tokens)) return record.tokens;
        return [];
    }

    function promptInsertionBefore(record) {
        return record && typeof record.before === "string" ? record.before : null;
    }

    function promptTagSpans(text) {
        const source = text || "";
        const spans = [];
        let start = 0;
        let depth = 0;

        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            if (char === "(") {
                depth += 1;
            } else if (char === ")" && depth > 0) {
                depth -= 1;
            } else if (char === "," && depth === 0) {
                spans.push({start, end: index, text: source.slice(start, index)});
                start = index + 1;
            }
        }

        spans.push({start, end: source.length, text: source.slice(start)});
        return spans;
    }

    function removePromptTokens(text, tokens, identity, separator) {
        const source = text || "";
        if (!tokens.length || !source) return source;

        const spans = promptTagSpans(source);
        const removeIndexes = spans
            .map((span, index) => ({span, index}))
            .filter(({span}) => tokens.some((token) => tokenMatchesPromptPart(span.text, token, identity)))
            .map(({index}) => index);

        if (!removeIndexes.length) return source;

        const ranges = removeIndexes.map((index) => {
            const span = spans[index];
            if (index < spans.length - 1) {
                return {start: span.start, end: spans[index + 1].start};
            }
            if (index > 0) {
                return {start: spans[index - 1].end, end: span.end};
            }
            return {start: 0, end: source.length};
        }).sort((left, right) => left.start - right.start);

        const merged = [];
        ranges.forEach((range) => {
            const last = merged[merged.length - 1];
            if (last && range.start <= last.end) {
                last.end = Math.max(last.end, range.end);
            } else {
                merged.push(Object.assign({}, range));
            }
        });

        let next = "";
        let cursor = 0;
        merged.forEach((range) => {
            next += source.slice(cursor, range.start);
            cursor = range.end;
        });
        next += source.slice(cursor);
        return next;
    }

    function appendPromptTokens(text, tokens, identity, separator) {
        let next = text || "";
        tokens.forEach((token) => {
            if (!promptContainsTokens(next, [token], identity)) {
                next = appendPrompt(next, token, separator);
            }
        });
        return next;
    }

    function applyPromptToggle(textarea, tabname, negative, identity, tokens, preserveTrailingComma, shouldAdd) {
        const separator = opts.extra_networks_add_text_separator || " ";
        const key = promptTrackerKey(tabname, negative, identity);
        const trackedRecord = state.promptInsertions.get(key);
        const tracked = promptInsertionTokens(trackedRecord);
        if (!tokens.length && !tracked.length) return;

        const currentValue = textarea.value || "";
        const currentPresent = promptContainsTokens(currentValue, tokens, identity);
        const loraTokens = tokens.filter((token) => /^<lora:/i.test(token));
        const removeTokens = tracked.length ? tracked : (currentPresent ? tokens : (shouldAdd ? loraTokens : []));
        let text = removePromptTokens(currentValue, removeTokens, identity, separator);

        const trackedBefore = promptInsertionBefore(trackedRecord);
        if (!shouldAdd && tracked.length && trackedBefore !== null) {
            const expected = finishPromptAppend(appendPromptTokens(trackedBefore, tracked, identity, separator), preserveTrailingComma);
            if (currentValue === expected) {
                text = trackedBefore;
            }
        }

        if (shouldAdd && tokens.length) {
            text = appendPromptTokens(text, tokens, identity, separator);
            text = finishPromptAppend(text, preserveTrailingComma);
            state.promptInsertions.set(key, {tokens: tokens.slice(), before: currentValue});
        } else {
            state.promptInsertions.delete(key);
        }

        textarea.value = text;
        updateInput(textarea);
    }

    function applySetToPrompt(identity, card, set) {
        const tabname = getCurrentGenerationType();
        const positive = promptTextarea(tabname, false);
        const negative = promptTextarea(tabname, true);

        const positiveTokens = buildSetPromptTokens(identity, set);
        const negativeTokens = splitTags(set.negative_prompt);
        const positiveKey = promptTrackerKey(tabname, false, identity);
        const trackedPositive = promptInsertionTokens(state.promptInsertions.get(positiveKey));
        const positivePresent = positive ? promptContainsTokens(positive.value || "", positiveTokens, identity) : false;
        const isSameTrackedSet = trackedPositive.length > 0 && samePromptTokens(trackedPositive, positiveTokens);
        const shouldAdd = !(positivePresent && (!trackedPositive.length || isSameTrackedSet));

        if (positive) {
            applyPromptToggle(positive, tabname, false, identity, positiveTokens, endsWithPromptComma(set.activation_text), shouldAdd);
        }

        if (negative) {
            applyPromptToggle(negative, tabname, true, identity, negativeTokens, endsWithPromptComma(set.negative_prompt), shouldAdd);
        }
    }

    function appendPrompt(text, value, separator) {
        const source = text || "";
        const trailing = source.match(/\s*$/)[0];
        const body = source.slice(0, source.length - trailing.length);
        if (!body.trim()) return `${value}${trailing}`;
        if (/,\s*$/.test(body)) {
            return `${body}${/\s$/.test(body) ? "" : separator}${value}${trailing}`;
        }
        return `${body},${separator}${value}${trailing}`;
    }

    function endsWithPromptComma(text) {
        return /,\s*$/.test(text || "");
    }

    function cleanupPrompt(text, separator, preserveTrailingComma) {
        let cleaned = text
            .replace(/ *,+ */g, `,${separator}`)
            .trim();
        if (preserveTrailingComma && cleaned && !/,\s*$/.test(cleaned)) {
            cleaned += ",";
        }
        if (!preserveTrailingComma) {
            cleaned = cleaned.replace(/\s*,?\s*$/g, "").trim();
        }
        return cleaned;
    }

    function finishPromptAppend(text, preserveTrailingComma) {
        if (!preserveTrailingComma || !text.trim() || /,\s*$/.test(text)) return text;
        return `${text.replace(/\s*$/, "")},`;
    }

    function openLightbox(src, context) {
        if (!src) return;
        let lightbox = document.querySelector(".fbc-lightbox");
        if (!lightbox) {
            lightbox = document.createElement("div");
            lightbox.className = "fbc-lightbox";
            const panel = document.createElement("div");
            panel.className = "fbc-lightbox-panel";
            const close = makeButton("x", "Close full image");
            close.className = "fbc-lightbox-close";
            const imageWrap = document.createElement("div");
            imageWrap.className = "fbc-lightbox-image-wrap";
            const img = document.createElement("img");
            img.alt = "";
            img.decoding = "async";
            imageWrap.appendChild(img);
            const controls = document.createElement("div");
            controls.className = "fbc-lightbox-controls";
            const prev = makeButton("<", "Previous image");
            const zoomOut = makeButton("-", "Zoom out");
            const zoomReset = makeButton("Reset", "Reset zoom");
            const zoomIn = makeButton("+", "Zoom in");
            const next = makeButton(">", "Next image");
            const add = makeButton("+ Image", "Add image to this set");
            const remove = makeButton("Remove", "Remove current image from this set");
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/png,image/jpeg,image/webp,image/gif";
            input.className = "fbc-hidden-file";
            prev.className = "fbc-lightbox-prev";
            next.className = "fbc-lightbox-next";
            add.className = "fbc-lightbox-add";
            remove.className = "fbc-lightbox-remove";
            controls.append(prev, zoomOut, zoomReset, zoomIn, next, add, remove, input);
            panel.append(close, imageWrap, controls);
            lightbox.appendChild(panel);
            close.addEventListener("click", () => lightbox.hidden = true);
            lightbox.addEventListener("click", (event) => {
                if (event.target === lightbox) lightbox.hidden = true;
            });
            prev.addEventListener("click", () => lightboxStepImage(lightbox, -1));
            next.addEventListener("click", () => lightboxStepImage(lightbox, 1));
            zoomOut.addEventListener("click", () => lightboxZoom(lightbox, -0.15));
            zoomIn.addEventListener("click", () => lightboxZoom(lightbox, 0.15));
            zoomReset.addEventListener("click", () => lightboxSetZoom(lightbox, 1));
            add.addEventListener("click", () => input.click());
            remove.addEventListener("click", () => lightboxRemoveImage(lightbox));
            imageWrap.addEventListener("wheel", (event) => {
                event.preventDefault();
                lightboxZoom(lightbox, event.deltaY > 0 ? -0.08 : 0.08);
            }, {passive: false});
            imageWrap.addEventListener("pointerdown", (event) => lightboxStartPan(event, lightbox));
            input.addEventListener("change", async () => {
                const file = input.files && input.files[0];
                input.value = "";
                if (!file || !lightbox._fbcContext) return;
                try {
                    const url = await uploadImage(file);
                    const ctx = lightbox._fbcContext;
                    addImageToSet(ctx.set, url, true);
                    updateEditorPreview(ctx.editor, ctx.set);
                    updateVisibleCardFronts(ctx.identity, ctx.card);
                    rememberCard(ctx.identity, ctx.card);
                    await saveNow(ctx.identity, ctx.card, ctx.host);
                    renderLightbox(lightbox);
                } catch (error) {
                    console.warn("[ForgeBetterCards] Failed to add lightbox image", error);
                }
            });
            document.body.appendChild(lightbox);
        }

        lightbox._fbcContext = context || null;
        lightbox._fbcFallbackSrc = src;
        lightboxResetView(lightbox);
        renderLightbox(lightbox);
        lightbox.hidden = false;
    }

    function renderLightbox(lightbox) {
        const ctx = lightbox._fbcContext;
        const set = ctx && ctx.set;
        const images = set ? (Array.isArray(set.images) ? set.images : []) : [lightbox._fbcFallbackSrc].filter(Boolean);
        const activeIndex = set ? Math.max(0, Math.min(Number(set.active_image_index || 0), images.length - 1)) : 0;
        const img = lightbox.querySelector("img");
        const nextSrc = images[activeIndex] || "";
        setImageSrc(img, nextSrc);
        lightbox.querySelector(".fbc-lightbox-prev").disabled = images.length < 2;
        lightbox.querySelector(".fbc-lightbox-next").disabled = images.length < 2;
        lightbox.querySelector(".fbc-lightbox-add").disabled = !ctx;
        lightbox.querySelector(".fbc-lightbox-remove").disabled = !ctx || !images.length;
        if (set) preloadAdjacentImages(set);
        lightboxApplyView(lightbox);
    }

    function lightboxStepImage(lightbox, delta) {
        const ctx = lightbox._fbcContext;
        if (!ctx || !ctx.set || !Array.isArray(ctx.set.images) || ctx.set.images.length < 2) return;
        setActiveImage(ctx.set, Number(ctx.set.active_image_index || 0) + delta);
        lightboxResetView(lightbox);
        updateEditorPreview(ctx.editor, ctx.set);
        updateVisibleCardFronts(ctx.identity, ctx.card);
        rememberCard(ctx.identity, ctx.card);
        renderLightbox(lightbox);
        saveNow(ctx.identity, ctx.card, ctx.host).catch((error) => {
            console.warn("[ForgeBetterCards] Failed to save lightbox image selection", error);
        });
    }

    async function lightboxRemoveImage(lightbox) {
        const ctx = lightbox._fbcContext;
        if (!ctx || !ctx.set || !Array.isArray(ctx.set.images) || !ctx.set.images.length) return;
        if (!window.confirm("Remove this image from this set?")) return;

        removeActiveImageFromSet(ctx.set);
        lightboxResetView(lightbox);
        updateEditorPreview(ctx.editor, ctx.set);
        updateVisibleCardFronts(ctx.identity, ctx.card);
        rememberCard(ctx.identity, ctx.card);
        if (!ctx.set.images.length) {
            lightbox.hidden = true;
        } else {
            renderLightbox(lightbox);
        }

        try {
            await saveNow(ctx.identity, ctx.card, ctx.host);
        } catch (error) {
            console.warn("[ForgeBetterCards] Failed to remove lightbox image", error);
        }
    }

    function lightboxZoom(lightbox, delta) {
        lightboxSetZoom(lightbox, (lightbox._fbcZoom || 1) + delta);
    }

    function lightboxSetZoom(lightbox, value) {
        const zoom = Math.max(0.6, Math.min(2.5, value));
        lightbox._fbcZoom = zoom;
        lightbox._fbcPanBounds = null;
        lightboxClampPan(lightbox);
        lightboxApplyView(lightbox);
    }

    function lightboxResetView(lightbox) {
        lightbox._fbcZoom = 1;
        lightbox._fbcPanX = 0;
        lightbox._fbcPanY = 0;
        lightboxApplyView(lightbox);
    }

    function lightboxApplyView(lightbox) {
        const img = lightbox.querySelector("img");
        if (!img) return;
        img.style.setProperty("--fbc-zoom", String(lightbox._fbcZoom || 1));
        img.style.setProperty("--fbc-pan-x", `${lightbox._fbcPanX || 0}px`);
        img.style.setProperty("--fbc-pan-y", `${lightbox._fbcPanY || 0}px`);
        const wrap = lightbox.querySelector(".fbc-lightbox-image-wrap");
        if (wrap) wrap.dataset.zoomed = (lightbox._fbcZoom || 1) > 1.01 ? "true" : "false";
    }

    function lightboxRequestApplyView(lightbox) {
        if (lightbox._fbcApplyFrame) return;
        lightbox._fbcApplyFrame = requestAnimationFrame(() => {
            lightbox._fbcApplyFrame = null;
            lightboxApplyView(lightbox);
        });
    }

    function lightboxClampPan(lightbox) {
        const wrap = lightbox.querySelector(".fbc-lightbox-image-wrap");
        if (!wrap) return;
        const zoom = lightbox._fbcZoom || 1;
        if (zoom <= 1.01) {
            lightbox._fbcPanX = 0;
            lightbox._fbcPanY = 0;
            return;
        }

        if (!lightbox._fbcPanBounds) {
            lightbox._fbcPanBounds = {
                x: Math.max(0, (wrap.clientWidth * (zoom - 1)) / 2),
                y: Math.max(0, (wrap.clientHeight * (zoom - 1)) / 2),
            };
        }
        const maxX = lightbox._fbcPanBounds.x;
        const maxY = lightbox._fbcPanBounds.y;
        lightbox._fbcPanX = Math.max(-maxX, Math.min(maxX, lightbox._fbcPanX || 0));
        lightbox._fbcPanY = Math.max(-maxY, Math.min(maxY, lightbox._fbcPanY || 0));
    }

    function lightboxStartPan(event, lightbox) {
        if ((lightbox._fbcZoom || 1) <= 1.01) return;
        event.preventDefault();
        const wrap = lightbox.querySelector(".fbc-lightbox-image-wrap");
        if (!wrap) return;
        wrap.setPointerCapture(event.pointerId);
        wrap.dataset.dragging = "true";

        const startX = event.clientX;
        const startY = event.clientY;
        const baseX = lightbox._fbcPanX || 0;
        const baseY = lightbox._fbcPanY || 0;
        lightbox._fbcPanBounds = null;
        lightboxClampPan(lightbox);

        function move(moveEvent) {
            lightbox._fbcPanX = baseX + moveEvent.clientX - startX;
            lightbox._fbcPanY = baseY + moveEvent.clientY - startY;
            lightboxClampPan(lightbox);
            lightboxRequestApplyView(lightbox);
        }

        function end() {
            wrap.dataset.dragging = "false";
            lightbox._fbcPanBounds = null;
            wrap.removeEventListener("pointermove", move);
            wrap.removeEventListener("pointerup", end);
            wrap.removeEventListener("pointercancel", end);
        }

        wrap.addEventListener("pointermove", move);
        wrap.addEventListener("pointerup", end);
        wrap.addEventListener("pointercancel", end);
    }

    function tick() {
        injectCardNavigation();
        injectEditorPages();
        setupMetadataPopupScroll();
        setupDirectoryControls();
    }

    function setupMetadataPopupScroll() {
        const popup = document.querySelector(".global-popup");
        if (!popup) return;
        const isMetadataPopup = !!popup.querySelector(".edit-user-metadata");
        popup.classList.toggle("fbc-metadata-popup", isMetadataPopup);

        const inner = popup.querySelector(".global-popup-inner");
        if (isMetadataPopup && inner && inner.dataset.fbcWheelScrollReady !== "true") {
            inner.dataset.fbcWheelScrollReady = "true";
            inner.addEventListener("scroll", () => {
                state.metadataScrollLockUntil = Date.now() + 450;
            }, {passive: true});
            inner.addEventListener("wheel", (event) => {
                if (!popup.classList.contains("fbc-metadata-popup") || !event.deltaY) return;
                if (hasScrollableAncestor(event.target, inner, event.deltaY)) return;
                if (!canScrollElement(inner, event.deltaY)) return;
                event.preventDefault();
                scheduleMetadataWheelScroll(inner, event.deltaY);
            }, { passive: false });
        }
    }

    function scheduleMetadataWheelScroll(element, deltaY) {
        element._fbcWheelDeltaY = (element._fbcWheelDeltaY || 0) + deltaY;
        if (element._fbcWheelFrame) return;
        element._fbcWheelFrame = requestAnimationFrame(() => {
            element.scrollTop += element._fbcWheelDeltaY || 0;
            element._fbcWheelDeltaY = 0;
            element._fbcWheelFrame = null;
        });
    }

    function canScrollElement(element, deltaY) {
        if (!element || element === document.documentElement || element === document.body) return false;
        const style = window.getComputedStyle(element);
        if (!/(auto|scroll)/.test(style.overflowY)) return false;
        const maxScroll = element.scrollHeight - element.clientHeight;
        if (maxScroll <= 1) return false;
        return deltaY < 0 ? element.scrollTop > 0 : element.scrollTop < maxScroll - 1;
    }

    function hasScrollableAncestor(target, stopAt, deltaY) {
        for (let element = target; element && element !== stopAt; element = element.parentElement) {
            if (canScrollElement(element, deltaY)) return true;
        }
        return false;
    }

    function setDirectoryToggleIcon(button, open) {
        button.innerHTML = open
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
        button.title = open ? "Hide folders" : "Show folders";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function cardsForSetToggle(button, fallback) {
        const cardsId = button && button.dataset ? button.dataset.fbcCardsId : "";
        return (cardsId && getApp().getElementById(cardsId)) || fallback || null;
    }

    async function setSetsToggleState(button, cards, enabled) {
        cards = cardsForSetToggle(button, cards);
        button.classList.toggle("fbc-sets-toggle-on", enabled);
        button.title = enabled ? "Hide set controls" : "Show set controls";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", enabled ? "true" : "false");
        if (cards) {
            cards.classList.toggle("fbc-sets-hidden", !enabled);
            if (enabled) {
                await loadIndex(true);
                observeCards(cards.querySelectorAll(".card[data-name]"));
                await reconcileVisibleCards(cards);
                scheduleSetReconcile(button);
            }
        }
    }

    function scheduleSetReconcile(button) {
        [150, 600, 1400].forEach((delay) => {
            setTimeout(async () => {
                if (!button || button.getAttribute("aria-pressed") !== "true") return;
                const cards = cardsForSetToggle(button);
                if (!cards) return;
                await loadIndex(true);
                observeCards(cards.querySelectorAll(".card[data-name]"));
                await reconcileVisibleCards(cards);
            }, delay);
        });
    }

    async function reconcileVisibleCards(cards) {
        const visible = Array.from(cards.querySelectorAll(".card[data-name]"))
            .filter((card) => isCardNearViewport(card))
            .slice(0, 80);
        await Promise.allSettled(visible.map(async (card) => {
            if (!card || !card.isConnected) return;
            const identity = resolveIdentity(identityFromCard(card));
            const summary = state.index ? state.index[identity.key] : null;
            if (summary && summary.has_card_data) {
                updateCardFront(card, summary);
                card.dataset.fbcProcessedMarker = [summary.set_count, summary.selected_set_id, summary.selected_set_label || "", summary.selected_image_url, summary.use_count || 0, summary.last_used || 0].join("|");
            } else {
                await hydrateCardFrontFromBackend(card, identity);
            }
        }));
    }

    function setupSetToggles() {
        getApp().querySelectorAll(".extra-network-control[id$='_controls']").forEach((controls) => {
            const match = controls.id.match(/^(txt2img|img2img)_(.+)_controls$/);
            if (!match) return;
            const cardsId = `${match[1]}_${match[2]}_cards`;
            const existing = controls.querySelector(".fbc-sets-toggle");
            if (controls.dataset.fbcSetToggleReady === "true" && existing) {
                existing.dataset.fbcCardsId = cardsId;
                return;
            }
            const cards = getApp().getElementById(cardsId);
            if (!cards) return;
            controls.dataset.fbcSetToggleReady = "true";

        const toggle = makeIconButton('<span class="fbc-sets-toggle-label">Set</span><span class="fbc-sets-toggle-track"><span></span></span>', "Show set controls");
        toggle.className = "fbc-sets-toggle";
        toggle.dataset.fbcCardsId = cardsId;
        toggle.addEventListener("click", async () => {
            const enabled = toggle.getAttribute("aria-pressed") !== "true";
            await setSetsToggleState(toggle, cardsForSetToggle(toggle, cards), enabled);
        });
            const search = getApp().getElementById(`${match[1]}_${match[2]}_extra_search`);
            if (search && search.parentElement && search.parentElement.parentElement === controls) {
                controls.insertBefore(toggle, search.parentElement);
            } else {
                controls.insertBefore(toggle, controls.firstChild);
            }
            setSetsToggleState(toggle, cardsForSetToggle(toggle, cards), false);
        });
    }

    function setupDirectoryControls() {
        patchDirectorySearchButton();
        getApp().querySelectorAll(".extra-network-dirs").forEach((dirs) => {
            dirs.classList.remove("fbc-dirs-compact", "fbc-dirs-expanded");
            let toggle = dirs.previousElementSibling && dirs.previousElementSibling.classList.contains("fbc-dirs-toggle")
                ? dirs.previousElementSibling
                : null;
            if (dirs.dataset.fbcFolderControlsReady !== "true") {
                dirs.dataset.fbcFolderControlsReady = "true";
                dirs.classList.add("fbc-dirs-collapsed");
                toggle = makeButton("", "Show folders");
                toggle.className = "fbc-dirs-toggle";
                setDirectoryToggleIcon(toggle, false);
                toggle.addEventListener("click", () => {
                    const open = !dirs.classList.contains("fbc-dirs-open");
                    dirs.classList.toggle("fbc-dirs-open", open);
                    dirs.classList.toggle("fbc-dirs-collapsed", !open);
                    setDirectoryToggleIcon(toggle, open);
                    saveDirectoryState(dirs);
                });
                dirs.insertAdjacentElement("beforebegin", toggle);
            }
            const marker = getDirectoryButtons(dirs).map(getDirectoryButtonLabel).join("\n");
            const saved = readDirectoryState(dirs);
            if (dirs.dataset.fbcFolderMarker !== marker || directoryStateNeedsRestore(dirs, saved)) {
                dirs.dataset.fbcFolderMarker = marker;
                restoreDirectoryState(dirs, toggle, saved);
            }
            applySelectedDirectoryFilterFromDirs(dirs);
        });
    }

    function getDirectoryButtons(dirs) {
        return Array.from(dirs.querySelectorAll("button"))
            .filter((button) => !button.classList.contains("search-all"));
    }

    function getDirectoryButtonLabel(button) {
        return (button && button.textContent || "").trim();
    }

    function getDirectoryContext(dirs) {
        const pane = dirs && dirs.closest(".extra-network-pane");
        const match = pane && pane.id && pane.id.match(/^(txt2img|img2img)_(.+)_pane$/);
        if (!match) return null;
        return {
            tabname: match[1],
            extra_networks_tabname: match[2],
            key: `fbc-directory-state:${match[1]}:${match[2]}`,
        };
    }

    function readDirectoryState(dirs) {
        const ctx = getDirectoryContext(dirs);
        if (!ctx || !window.sessionStorage) return null;
        try {
            const raw = window.sessionStorage.getItem(ctx.key);
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            return null;
        }
    }

    function saveDirectoryState(dirs) {
        const ctx = getDirectoryContext(dirs);
        if (!ctx || !window.sessionStorage) return;
        const states = getDirectoryButtons(dirs)
            .map((button) => ({
                label: getDirectoryButtonLabel(button),
                state: button.dataset.fbcDirState || "",
            }))
            .filter((item) => item.label && (item.state === "include" || item.state === "exclude"));
        try {
            window.sessionStorage.setItem(ctx.key, JSON.stringify({
                open: dirs.classList.contains("fbc-dirs-open"),
                states,
            }));
        } catch (error) {
            // Ignore private-mode or quota failures; filtering still works for the current DOM.
        }
    }

    function directoryStateNeedsRestore(dirs, saved) {
        if (!saved) return false;

        const savedOpen = saved.open === true;
        if (dirs.classList.contains("fbc-dirs-open") !== savedOpen) return true;

        const savedStates = new Map((Array.isArray(saved.states) ? saved.states : [])
            .filter((item) => item && (item.state === "include" || item.state === "exclude"))
            .map((item) => [String(item.label || "").trim().toLowerCase(), item.state]));
        return getDirectoryButtons(dirs).some((button) => {
            const expected = savedStates.get(getDirectoryButtonLabel(button).toLowerCase()) || "";
            return (button.dataset.fbcDirState || "") !== expected;
        });
    }

    function restoreDirectoryState(dirs, toggle, saved) {
        saved = saved || readDirectoryState(dirs);
        if (!saved) return;

        const open = saved.open === true;
        dirs.classList.toggle("fbc-dirs-open", open);
        dirs.classList.toggle("fbc-dirs-collapsed", !open);
        if (toggle) setDirectoryToggleIcon(toggle, open);

        const savedStates = new Map((Array.isArray(saved.states) ? saved.states : [])
            .filter((item) => item && (item.state === "include" || item.state === "exclude"))
            .map((item) => [String(item.label || "").trim().toLowerCase(), item.state]));
        getDirectoryButtons(dirs).forEach((button) => {
            const stateValue = savedStates.get(getDirectoryButtonLabel(button).toLowerCase());
            if (stateValue) {
                button.dataset.fbcDirState = stateValue;
                if (stateValue === "include") {
                    button.dataset.fbcDirSelected = "true";
                } else {
                    delete button.dataset.fbcDirSelected;
                }
            } else {
                delete button.dataset.fbcDirState;
                delete button.dataset.fbcDirSelected;
            }
        });
    }

    function patchDirectorySearchButton() {
        if (state.directorySearchPatched || typeof window.extraNetworksSearchButton !== "function") return;
        state.directorySearchPatched = true;
        const original = window.extraNetworksSearchButton;
        window.extraNetworksSearchButton = function(tabname, extra_networks_tabname, event) {
            const button = event && event.target && event.target.closest ? event.target.closest("button") : null;
            const dirs = button && button.closest(".extra-network-dirs");
            if (!button || !dirs) return original(tabname, extra_networks_tabname, event);

            event.preventDefault();
            event.stopPropagation();

            if (button.classList.contains("search-all")) {
                dirs.querySelectorAll("button[data-fbc-dir-state]").forEach((item) => {
                    delete item.dataset.fbcDirSelected;
                    delete item.dataset.fbcDirState;
                });
            } else {
                const current = button.dataset.fbcDirState || "";
                if (!current) {
                    button.dataset.fbcDirState = "include";
                    button.dataset.fbcDirSelected = "true";
                } else if (current === "include") {
                    button.dataset.fbcDirState = "exclude";
                    delete button.dataset.fbcDirSelected;
                } else {
                    delete button.dataset.fbcDirState;
                    delete button.dataset.fbcDirSelected;
                }
            }
            saveDirectoryState(dirs);

            const search = getApp().querySelector(`#${tabname}_${extra_networks_tabname}_extra_search`);
            if (search) {
                search.value = "";
                updateInput(search);
            }
            setTimeout(() => applySelectedDirectoryFilter(tabname, extra_networks_tabname), 20);
        };
    }

    function applySelectedDirectoryFilterFromDirs(dirs) {
        const pane = dirs.closest(".extra-network-pane");
        const match = pane && pane.id && pane.id.match(/^(txt2img|img2img)_(.+)_pane$/);
        if (!match) return;
        applySelectedDirectoryFilter(match[1], match[2]);
    }

    function applySelectedDirectoryFilter(tabname, extra_networks_tabname) {
        const dirs = getApp().getElementById(`${tabname}_${extra_networks_tabname}_dirs`);
        const cards = getApp().getElementById(`${tabname}_${extra_networks_tabname}_cards`);
        if (!dirs || !cards) return;

        const selected = Array.from(dirs.querySelectorAll("button[data-fbc-dir-state='include']"))
            .map((button) => button.textContent.trim().toLowerCase())
            .filter(Boolean);
        const excluded = Array.from(dirs.querySelectorAll("button[data-fbc-dir-state='exclude']"))
            .map((button) => button.textContent.trim().toLowerCase())
            .filter(Boolean);

        cards.querySelectorAll(".card").forEach((card) => {
            if (!selected.length && !excluded.length) {
                card.classList.remove("fbc-dir-hidden");
                return;
            }
            const text = Array.from(card.querySelectorAll(".search_terms, .description, [data-filterable-item-text]"))
                .map((node) => node.textContent.toLowerCase())
                .join(" ");
            const includeMatch = !selected.length || selected.some((folder) => text.includes(folder));
            const excludeMatch = excluded.some((folder) => text.includes(folder));
            card.classList.toggle("fbc-dir-hidden", !includeMatch || excludeMatch);
        });
    }

    function scheduleTick(forceIndex) {
        if (state.scheduled) return;
        state.scheduled = true;
        const run = async () => {
            state.scheduled = false;
            if (forceIndex) await loadIndex(true);
            tick();
        };
        if ("requestIdleCallback" in window) {
            requestIdleCallback(run, {timeout: 800});
        } else {
            setTimeout(run, 120);
        }
    }

    function scheduleBootRefresh() {
        state.bootRefreshUntil = Date.now() + 12000;
        [250, 800, 1600, 3200, 6400, 10000].forEach((delay) => {
            setTimeout(() => {
                if (Date.now() <= state.bootRefreshUntil) scheduleTick(true);
            }, delay);
        });
    }

    function setupMutationObserver() {
        if (state.mutationObserver) return;
        state.mutationObserver = new MutationObserver((mutations) => {
            if (mutations.some(mutationRelevant)) {
                scheduleTick(false);
            }
        });
        state.mutationObserver.observe(getApp(), {childList: true, subtree: true});
    }

    function mutationRelevant(mutation) {
        if (!mutation.addedNodes.length && !mutation.removedNodes.length) return false;

        for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
            if (nodeRelevant(node)) return true;
        }
        return false;
    }

    function nodeRelevant(node) {
        if (!node || node.nodeType !== 1) return false;
        if (node.closest && node.closest(".fbc-lightbox")) return false;
        if (node.matches && node.matches(".extra-network-cards, .extra-network-cards .card, .edit-user-metadata, [id$='_cards']")) return true;
        return !!(node.querySelector && node.querySelector(".extra-network-cards, .extra-network-cards .card, .edit-user-metadata, [id$='_cards']"));
    }

    window.addEventListener("keydown", (event) => {
        const lightbox = document.querySelector(".fbc-lightbox");
        if (!lightbox || lightbox.hidden) return;
        if (event.key === "Escape") lightbox.hidden = true;
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            lightboxStepImage(lightbox, -1);
        }
        if (event.key === "ArrowRight") {
            event.preventDefault();
            lightboxStepImage(lightbox, 1);
        }
    });

    onUiLoaded(() => {
        scheduleBootRefresh();
        setupMutationObserver();
    });
    if (typeof onAfterUiUpdate === "function") {
        onAfterUiUpdate(() => scheduleTick(Date.now() <= state.bootRefreshUntil));
    }
    if (typeof onUiTabChange === "function") {
        onUiTabChange(() => scheduleTick(Date.now() <= state.bootRefreshUntil));
    }
})();
