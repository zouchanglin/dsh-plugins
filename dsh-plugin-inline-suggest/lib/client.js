/**
 * Inline ghost-text suggestions for the DSH composer.
 *
 * Behaviour
 *  - While you type in the composer, a grey continuation of what you are typing
 *    is painted immediately after the caret.
 *  - Tab accepts it: the grey text becomes ordinary draft text at the normal
 *    text colour.
 *  - Escape dismisses the current suggestion until the draft changes again.
 *
 * Why a DOM overlay instead of a slot: the composer is a Lexical contenteditable
 * owned by ui-conversation, and no slot renders inside its text flow. This
 * plugin therefore measures the caret with a collapsed Range and paints an
 * absolutely positioned overlay on top of it, which keeps it independent of the
 * editor implementation and of ui-conversation internals.
 *
 * Prediction is local: the plugin learns the prompts you actually send (per
 * browser profile) and completes them by prefix plus a small built-in seed
 * corpus. No network calls, nothing leaves the machine.
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-inline-suggest",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const LS_HISTORY = "dsh.inline-suggest.history.v1";
		const LS_ENABLED = "dsh.inline-suggest.enabled";
		const LS_CONTEXT = "dsh.inline-suggest.context";
		const CONTEXT_ENDPOINT = "/inline-suggest/predict";
		const MAX_HISTORY = 240;
		const MIN_DRAFT = 2;
		const MAX_SUGGEST = 40;
		const MIN_LEARN = 6;
		const EDITOR_SELECTOR = '[data-lexical-editor="true"]';

		/** Which branch the update loop last took; surfaced through the Host status route. */
		let branch = "";
		let fetchNote = "none";

		/** Seed corpus so suggestions exist before any prompt has been sent. */
		const SEED = [
			"帮我写一个", "帮我实现一个", "帮我看看这段代码", "帮我看一下这个报错",
			"帮我优化一下", "帮我解释一下", "帮我检查一下", "帮我生成一个",
			"帮我把这段代码重构一下", "帮我把这个改成", "帮我列出", "帮我总结一下",
			"总结一下上面的内容", "继续上面的工作", "用 TypeScript 重写一下",
			"解释一下这段代码的作用", "这个报错是什么原因", "怎么解决这个问题",
			"现在给我", "然后帮我", "顺便检查一下",
			"please help me", "can you explain", "write a function that",
			"let me know if", "I want to"
		];

		let history = [];
		let enabled = true;
		let composing = false;
		let dismissedFor = "";
		let prevDraft = "";
		let ghost = null;
		let state = { visible: false, text: "", editor: null };
		let scheduled = false;
		let installed = false;
		/** Disposer of a previous instance left behind by a hot reload. */
		let pendingDispose = null;
		/** Context prediction: one cached guess per conversation state. */
		let ctxState = { key: "", text: "", asked: false };
		let ctxTimer = 0;
		let ctxInFlight = false;
		let convCache = { at: 0, value: null };
		let pollTimer = 0;

		/* ------------------------------------------------------------------ */
		/* storage                                                             */
		/* ------------------------------------------------------------------ */

		function loadHistory() {
			try {
				const raw = window.localStorage.getItem(LS_HISTORY);
				const list = raw ? JSON.parse(raw) : [];
				return Array.isArray(list) ? list.filter((x) => typeof x === "string" && x) : [];
			} catch {
				return [];
			}
		}

		function saveHistory() {
			try {
				window.localStorage.setItem(LS_HISTORY, JSON.stringify(history.slice(0, MAX_HISTORY)));
			} catch {
				/* storage disabled: suggestions still work in-memory */
			}
		}

		function loadEnabled() {
			try {
				return window.localStorage.getItem(LS_ENABLED) !== "0";
			} catch {
				return true;
			}
		}

		function remember(text) {
			const clean = String(text || "").trim();
			if (clean.length < MIN_LEARN) return;
			if (history[0] === clean) return;
			history = [clean, ...history.filter((x) => x !== clean)].slice(0, MAX_HISTORY);
			saveHistory();
		}

		/* ------------------------------------------------------------------ */
		/* prediction                                                          */
		/* ------------------------------------------------------------------ */

		function corpus() {
			const set = new Set(history);
			for (const seed of SEED) set.add(seed);
			return [...set];
		}

		function predict(draft) {
			const d = String(draft || "").trimEnd();
			if (!d) return "";

			const lines = corpus();

			// 1) the draft is the beginning of a known prompt: complete the rest.
			//    Prefer the shortest continuation: it is the least intrusive guess
			//    and leaves the longer variants reachable by typing more.
			let best = "";
			for (const line of lines) {
				if (line.length <= d.length || !line.startsWith(d)) continue;
				const rest = line.slice(d.length);
				if (!best || rest.length < best.length) best = rest;
			}
			if (best) return clip(best);

			// 2) the draft ends in a half-typed latin word: finish the word.
			const word = d.match(/([A-Za-z][A-Za-z0-9_-]{1,39})$/);
			if (word) {
				const partial = word[1].toLowerCase();
				const votes = new Map();
				for (const line of lines) {
					for (const token of line.match(/[A-Za-z][A-Za-z0-9_-]{2,39}/g) || []) {
						const lower = token.toLowerCase();
						if (lower.length > partial.length && lower.startsWith(partial)) {
							votes.set(token, (votes.get(token) || 0) + 1);
						}
					}
				}
				if (votes.size) {
					const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
					return clip(ranked[0][0].slice(word[1].length));
				}
			}

			return "";
		}

		function clip(text) {
			if (!text) return "";
			return text.length > MAX_SUGGEST ? text.slice(0, MAX_SUGGEST) : text;
		}

		/* ------------------------------------------------------------------ */
		/* DOM helpers                                                         */
		/* ------------------------------------------------------------------ */

		function currentEditor() {
			const active = document.activeElement;
			if (active && active.closest) {
				const root = active.closest(EDITOR_SELECTOR);
				if (root) return root;
			}
			const sel = window.getSelection();
			if (sel && sel.anchorNode) {
				const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
				const root = node && node.closest ? node.closest(EDITOR_SELECTOR) : null;
				if (root) return root;
			}
			// Nothing focused: only an unambiguous single visible composer is
			// safe to predict into, otherwise we would paint into the wrong box.
			const visible = [...document.querySelectorAll(EDITOR_SELECTOR)].filter((node) => isVisible(node));
			return visible.length === 1 ? visible[0] : null;
		}

		function isVisible(editor) {
			const rects = editor.getClientRects();
			if (!rects || rects.length === 0) return false;
			const box = editor.getBoundingClientRect();
			return box.height > 0;
		}

		function draftOf(editor) {
			let text = "";
			try {
				text = editor.innerText;
			} catch {
				text = "";
			}
			if (typeof text !== "string" || text === "") text = editor.textContent || "";
			return String(text).replace(/\u200b/g, "").replace(/\r/g, "");
		}

		function caretAtEnd(editor, range) {
			try {
				const probe = document.createRange();
				probe.selectNodeContents(editor);
				probe.setStart(range.startContainer, range.startOffset);
				const tail = probe.toString().replace(/[\s\u00a0\u200b]+/g, "");
				return tail.length === 0;
			} catch {
				return false;
			}
		}

		function caretRect(editor) {
			let rect = null;
			const sel = window.getSelection();
			if (sel && sel.rangeCount > 0) {
				const range = sel.getRangeAt(0);
				// Only trust the selection when it really is this editor's caret;
				// an unfocused composer is painted at its own text origin instead.
				if (range.collapsed && editor.contains(range.startContainer)) {
					const rects = range.getClientRects();
					if (rects && rects.length) rect = rects[rects.length - 1];
					if (!rect || (!rect.width && !rect.height)) {
						const box = range.getBoundingClientRect();
						if (box && (box.width || box.height)) rect = box;
					}
				}
			}

			const editorBox = editor.getBoundingClientRect();
			const cs = window.getComputedStyle(editor);
			if (!rect || (!rect.width && !rect.height)) {
				// Collapsed caret on an empty trailing line, or no caret at all:
				// fall back to the editor's own top-left plus its padding.
				const lineHeight = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.5;
				rect = {
					left: editorBox.left + (parseFloat(cs.paddingLeft) || 0),
					top: editorBox.top + (parseFloat(cs.paddingTop) || 0),
					height: lineHeight
				};
			}
			if (!rect) return null;
			return rect;
		}

		function ensureGhost() {
			if (ghost && ghost.isConnected) return ghost;
			// A previous instance (HMR reload, duplicated entry) may have left its
			// own overlay behind; one ghost is all the composer may show.
			try {
				for (const stale of document.querySelectorAll('[data-dsh-inline-suggest="ghost"]')) stale.remove();
			} catch {
				/* ignore */
			}
			ghost = document.createElement("span");
			ghost.setAttribute("data-dsh-inline-suggest", "ghost");
			ghost.setAttribute("aria-hidden", "true");
			const style = ghost.style;
			style.position = "fixed";
			style.left = "0px";
			style.top = "0px";
			style.margin = "0";
			style.padding = "0";
			style.border = "0";
			style.background = "transparent";
			style.color = "var(--dsw-alias-label-tertiary, #9aa0a6)";
			style.opacity = "0.78";
			style.pointerEvents = "none";
			style.userSelect = "none";
			style.whiteSpace = "pre";
			style.overflow = "hidden";
			style.display = "none";
			style.zIndex = "2147483000";
			document.body.appendChild(ghost);
			return ghost;
		}

		function syncFont(editor, rect) {
			const g = ensureGhost();
			const cs = window.getComputedStyle(editor);
			const line = Math.max(rect.height || 0, parseFloat(cs.fontSize) || 14 * 1.4);
			g.style.fontFamily = cs.fontFamily;
			g.style.fontSize = cs.fontSize;
			g.style.fontWeight = cs.fontWeight;
			g.style.fontStyle = cs.fontStyle;
			g.style.letterSpacing = cs.letterSpacing;
			g.style.lineHeight = line + "px";
			g.style.height = line + "px";
			return g;
		}

		function hide() {
			state.visible = false;
			state.text = "";
			if (ghost) ghost.style.display = "none";
			restorePlaceholder();
		}

		/**
		 * The composer shows a placeholder while it is empty; the ghost owns that
		 * spot, so hide the placeholder while a suggestion is painted (otherwise
		 * the two greys overlap). The placeholder node is a sibling of the editor
		 * whose class carries "placeholder" and whose text equals the editor's
		 * `data-placeholder`.
		 */
		let placeholderEl = null;
		function hidePlaceholder(editor) {
			try {
				if (!placeholderEl || !placeholderEl.isConnected) {
					const scope = editor.parentElement || editor;
					const wanted = String(editor.getAttribute("data-placeholder") || "").trim();
					const found = [...scope.querySelectorAll('[class*="placeholder"]')];
					placeholderEl = found.find((node) => String(node.textContent || "").trim() === wanted) || found[0] || null;
				}
				if (placeholderEl) placeholderEl.style.visibility = "hidden";
			} catch {
				/* ignore */
			}
		}

		function restorePlaceholder() {
			try {
				if (placeholderEl) placeholderEl.style.visibility = "";
			} catch {
				/* ignore */
			}
		}

		function show(text, editor) {
			const rect = caretRect(editor);
			if (!rect) {
				hide();
				return;
			}
			const g = syncFont(editor, rect);
			if (state.text !== text) g.textContent = text;
			g.style.left = Math.round(rect.left) + "px";
			g.style.top = Math.round(rect.top) + "px";
			g.style.display = "block";
			state = { visible: true, text, editor };
			hidePlaceholder(editor);
		}

		/* ------------------------------------------------------------------ */
		/* update loop                                                         */
		/* ------------------------------------------------------------------ */

		/**
		 * Report the loop's current state to the Host (readable from
		 * `/inline-suggest/status`). One report per distinct tag keeps this
		 * cheap; it is the only way to see what the browser half is doing.
		 */
		const reported = new Set();

		function reportDebug(tag) {
			if (reported.has(tag)) return;
			reported.add(tag);
			try {
				const editors = [...document.querySelectorAll(EDITOR_SELECTOR)];
				const rows = [...document.querySelectorAll("[data-chat-flow-kind]")];
				const kinds = {};
				for (const row of rows) {
					const kind = row.getAttribute("data-chat-flow-kind") || "?";
					kinds[kind] = (kinds[kind] || 0) + 1;
				}
				const payload = {
					tag,
					at: new Date().toISOString(),
					enabled,
					contextEnabled: contextEnabled(),
					editors: editors.length,
					rows: rows.length,
					kinds,
					running: Boolean(document.querySelector("[data-chat-running]:not([data-holding])")),
					ctx: { key: ctxState.key, hasText: Boolean(ctxState.text), asked: ctxState.asked },
					ghost: { visible: state.visible, text: state.text },
					branch,
					fetchNote
				};
				window
					.fetch("/inline-suggest/debug", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload)
					})
					.catch(() => {});
			} catch {
				/* diagnostics must never break the feature */
			}
		}

		function hashString(text) {
			let hash = 5381;
			for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
			return (hash >>> 0).toString(36) + ":" + text.length;
		}

		/**
		 * Text of one transcript row.
		 *
		 * The transcript is owned by ui-conversation; its class names are build
		 * hashes, so extraction keys off the stable `data-*` contract instead:
		 * user rows carry `[data-message-bubble]`, assistant response steps carry
		 * the markdown body marked `data-text-interaction-source` (the same marker
		 * user bubbles use, so user rows are handled first).
		 */
		function rowText(node, kind) {
			const scoped =
				kind === "user"
					? node.querySelector("[data-message-bubble]") || node.querySelector('[data-slot="conversation.user.text.node"]')
					: node.querySelector("[data-text-interaction-source]");
			const holder = scoped || node;
			return String(holder.innerText || "").replace(/\s+$/g, "").trim();
		}

		/** Tail of the visible conversation, normalised for the Host prompt. */
		function readConversation() {
			const now = Date.now();
			if (convCache.value && now - convCache.at < 500) return convCache.value;
			const rows = [];
			for (const node of document.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="assistant-step"]')) {
				const flowKind = node.getAttribute("data-chat-flow-kind");
				// Assistant rows come in reasoning and response parts; only the
				// response carries what the user actually read.
				if (flowKind === "assistant-step" && node.getAttribute("data-chat-group-part") !== "response") continue;
				const text = rowText(node, flowKind).replace(/\n{3,}/g, "\n\n").trim();
				if (!text) continue;
				rows.push({ kind: flowKind === "user" ? "user" : "assistant", text });
			}
			let value;
			if (rows.length === 0) value = { context: "", lastKind: "" };
			else {
				const tail = rows
					.slice(-8)
					.map((row) => (row.kind === "user" ? "User: " : "Assistant: ") + row.text.slice(0, 1500));
				value = { context: tail.join("\n\n").slice(-6000), lastKind: rows[rows.length - 1].kind };
			}
			convCache = { at: now, value };
			return value;
		}

		function contextEnabled() {
			try {
				return window.localStorage.getItem(LS_CONTEXT) !== "0";
			} catch {
				return true;
			}
		}

		async function requestContext(context, key) {
			if (ctxInFlight) return;
			ctxInFlight = true;
			try {
				const response = await window.fetch(CONTEXT_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ context })
				});
				fetchNote = "http" + response.status;
				const data = await response.json();
				const suggestion = typeof data.suggestion === "string" ? data.suggestion.trim() : "";
				if (ctxState.key === key) ctxState.text = suggestion;
				if (suggestion && ctxState.key === key) schedule();
				else hide();
			} catch (error) {
				fetchNote = String((error && error.message) || error).slice(0, 60);
				reportDebug("fetch-failed:" + fetchNote);
				if (ctxState.key === key) ctxState.text = "";
				hide();
			} finally {
				ctxInFlight = false;
			}
		}

		/**
		 * Coalesce DOM work into one paint. A timer, not requestAnimationFrame:
		 * an Electron window that is occluded or was just opened may starve rAF,
		 * which would park the suggestion loop indefinitely.
		 */
		function schedule() {
			if (scheduled) return;
			scheduled = true;
			window.setTimeout(() => {
				scheduled = false;
				update();
			}, 16);
		}

		let reportedBranch = "";
		function noteBranch() {
			if (branch === reportedBranch) return;
			reportedBranch = branch;
			reportDebug("branch:" + branch);
		}

		function update() {
			try {
				updateBody();
			} finally {
				noteBranch();
			}
		}

		function updateBody() {
			if (!enabled) {
				branch = "disabled";
				hide();
				return;
			}
			const editor = currentEditor();
			if (!editor) {
				branch = "no-editor";
				reportDebug("no-editor");
				hide();
				return;
			}

			const text = draftOf(editor);
			if (prevDraft.trim().length >= MIN_LEARN && text.trim() === "") remember(prevDraft);
			prevDraft = text;

			if (composing || !isVisible(editor)) {
				branch = "invisible";
				hide();
				return;
			}
			if (document.querySelector('[role="listbox"]')) {
				// The slash/at-command menu owns the keyboard (and Tab) right now.
				branch = "listbox";
				hide();
				return;
			}

			const draft = text.trim();

			// ---- empty composer: guess the user's next message from the chat
			if (!draft) {
				if (Date.now() < acceptSettlingUntil) {
					branch = "accept-settling";
					hide();
					return;
				}
				if (!contextEnabled()) {
					branch = "context-off";
					hide();
					return;
				}
				// A running turn still streams its answer: wait for a settled
				// message before asking the model what the user would say next.
				// The running indicator keeps a hidden "holding" node after the
				// turn ends, so only the live one counts.
				if (document.querySelector("[data-chat-running]:not([data-holding])")) {
					branch = "running";
					reportDebug("running-turn");
					hide();
					return;
				}
				const focus = document.activeElement;
				const caretInside = window.getSelection() && window.getSelection().rangeCount > 0 && editor.contains(window.getSelection().getRangeAt(0).startContainer);
				const idleFocus = !focus || focus === document.body || focus === document.documentElement || editor.contains(focus);
				if (!caretInside && !idleFocus) {
					branch = "focus";
					reportDebug("focus-elsewhere");
					hide();
					return;
				}
				const snapshot = readConversation();
				if (!snapshot.context || snapshot.lastKind !== "assistant") {
					branch = "ctx:" + snapshot.lastKind;
					reportDebug("context-unusable:" + snapshot.lastKind + ":" + snapshot.context.length);
					hide();
					return;
				}
				const key = hashString(snapshot.context);
				if (ctxState.key !== key) ctxState = { key, text: "", asked: false };
				if (ctxState.text) {
					branch = "showing";
					reportDebug("showing-context");
					show(ctxState.text, editor);
					return;
				}
				if (!ctxState.asked) {
					branch = "requesting";
					ctxState.asked = true;
					reportDebug("requesting");
					const pendingKey = key;
					window.clearTimeout(ctxTimer);
					ctxTimer = window.setTimeout(() => {
						if (ctxState.key === pendingKey) requestContext(snapshot.context, pendingKey);
					}, 350);
				} else {
					branch = "asked";
					reportDebug("already-asked");
				}
				hide();
				return;
			}

			// ---- draft in progress: complete from the local corpus
			const sel = window.getSelection();
			if (!sel || sel.rangeCount === 0) {
				branch = "no-selection";
				hide();
				return;
			}
			const range = sel.getRangeAt(0);
			if (!range.collapsed || !editor.contains(range.startContainer)) {
				branch = "caret-away";
				hide();
				return;
			}
			if (draft.length < MIN_DRAFT || draft.startsWith("/")) {
				branch = "draft-short";
				hide();
				return;
			}
			if (dismissedFor === draft) {
				branch = "dismissed";
				hide();
				return;
			}
			if (!caretAtEnd(editor, range)) {
				branch = "caret-not-end";
				hide();
				return;
			}

			const suggestion = predict(draft);
			if (!suggestion) {
				branch = "draft-no-match";
				hide();
				return;
			}
			branch = "draft-local";
			show(suggestion, editor);
		}

		/* ------------------------------------------------------------------ */
		/* accept                                                              */
		/* ------------------------------------------------------------------ */

		/**
		 * Accept the visible suggestion.
		 *
		 * The composer is a Lexical contenteditable: `execCommand('insertText')`
		 * raises a native `beforeinput` that Lexical intercepts, then applies the
		 * change through its own model on the next update — so the DOM still shows
		 * the old draft synchronously. Judging success by reading the draft right
		 * away therefore fires the `beforeinput` fallback as well and inserts the
		 * suggestion TWICE. Success is checked after Lexical has flushed instead,
		 * and a short guard drops a second accept from a duplicate listener.
		 */
		let accepting = false;
		/** While Lexical is still flushing an accepted insertion, the draft looks
		 *  empty for a moment; predicting then would paint the suggestion again
		 *  on top of the inserted text. */
		let acceptSettlingUntil = 0;

		function accept() {
			const editor = state.editor;
			const text = state.text;
			if (!editor || !text || accepting) return false;
			accepting = true;
			acceptSettlingUntil = Date.now() + 700;
			window.setTimeout(() => {
				accepting = false;
			}, 300);

			const before = draftOf(editor);
			hide();

			if (document.activeElement !== editor && typeof editor.focus === "function") {
				try {
					editor.focus();
				} catch {
					/* ignore */
				}
			}

			let ok = false;
			try {
				ok = document.execCommand("insertText", false, text);
			} catch {
				ok = false;
			}

			window.setTimeout(() => {
				if (draftOf(editor) !== before) return;
				// execCommand did nothing here: dispatch the input the editor listens for.
				try {
					editor.dispatchEvent(
						new InputEvent("beforeinput", {
							bubbles: true,
							cancelable: true,
							inputType: "insertText",
							data: text
						})
					);
				} catch {
					/* ignore */
				}
			}, ok ? 200 : 0);

			prevDraft = draftOf(editor);
			schedule();
			return true;
		}

		/* ------------------------------------------------------------------ */
		/* events                                                              */
		/* ------------------------------------------------------------------ */

		function onKeyDown(event) {
			if (!state.visible) return;
			if (event.key === "Escape") {
				const editor = state.editor;
				const draft = editor ? draftOf(editor).trim() : "";
				if (draft) dismissedFor = draft;
				else {
					// Context guess dismissed: keep it away until the chat moves on.
					ctxState = { key: ctxState.key, text: "", asked: true };
				}
				hide();
				return;
			}
			if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
			event.preventDefault();
			event.stopPropagation();
			accept();
		}

		function onCompositionStart() {
			composing = true;
			hide();
		}

		function onCompositionEnd() {
			composing = false;
			schedule();
		}

		function onFocusOrInput() {
			dismissedFor = "";
			schedule();
		}

		const listeners = [
			["keydown", onKeyDown, true],
			["selectionchange", schedule, true],
			["input", schedule, true],
			["focusin", onFocusOrInput, true],
			["focusout", schedule, true],
			["compositionstart", onCompositionStart, true],
			["compositionend", onCompositionEnd, true],
			["scroll", hide, true],
			["resize", hide, true]
		];

		function install() {
			if (installed) return;
			// One live instance per page: a hot reload can leave the previous
			// factory's listeners and overlay behind, which would paint the
			// suggestion twice and accept it twice on one Tab.
			try {
				const prior = window.__DSH_INLINE_SUGGEST_DISPOSE__;
				if (typeof prior === "function") pendingDispose = prior;
			} catch {
				/* ignore */
			}
			installed = true;
			if (pendingDispose) {
				const dispose = pendingDispose;
				pendingDispose = null;
				try {
					dispose();
				} catch {
					/* ignore */
				}
			}
			for (const [type, handler, capture] of listeners) {
				document.addEventListener(type, handler, capture ? { capture: true, passive: type !== "keydown" } : false);
			}
			// The transcript settles without necessarily firing a selection or
			// scroll event (a turn finishing, a re-render), so poll lightly as a
			// safety net. update() itself is cheap: the DOM read is memoised.
			pollTimer = window.setInterval(schedule, 1200);
			window.setTimeout(() => reportDebug("install"), 900);
			try {
				console.info("[inline-suggest] ready — type in the composer, Tab accepts the grey suggestion");
			} catch {
				/* ignore */
			}
			window.__DSH_INLINE_SUGGEST__ = {
				version: "0.2.0",
				get state() {
					return {
						enabled,
						visible: state.visible,
						text: state.text,
						learned: history.length,
						context: { key: ctxState.key, suggestion: ctxState.text, asked: ctxState.asked }
					};
				},
				predict,
				readConversation,
				refresh: schedule,
				accept,
				setEnabled(next) {
					enabled = Boolean(next);
					try {
						window.localStorage.setItem(LS_ENABLED, enabled ? "1" : "0");
					} catch {
						/* ignore */
					}
					if (!enabled) hide();
					else schedule();
				},
				forget() {
					history = [];
					saveHistory();
				},
				setContextEnabled(next) {
					try {
						window.localStorage.setItem(LS_CONTEXT, next ? "1" : "0");
					} catch {
						/* ignore */
					}
					ctxState = { key: "", text: "", asked: false };
					hide();
					schedule();
				}
			};
			window.__DSH_INLINE_SUGGEST_DISPOSE__ = uninstall;
			schedule();
		}

		function uninstall() {
			if (!installed) return;
			installed = false;
			if (pollTimer) {
				window.clearInterval(pollTimer);
				pollTimer = 0;
			}
			window.clearTimeout(ctxTimer);
			for (const [type, handler, capture] of listeners) {
				document.removeEventListener(type, handler, capture ? { capture: true } : false);
			}
			if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
			ghost = null;
			restorePlaceholder();
			placeholderEl = null;
			try {
				if (window.__DSH_INLINE_SUGGEST_DISPOSE__ === uninstall) delete window.__DSH_INLINE_SUGGEST_DISPOSE__;
			} catch {
				/* ignore */
			}
			delete window.__DSH_INLINE_SUGGEST__;
		}

		/* ------------------------------------------------------------------ */
		/* plugin                                                              */
		/* ------------------------------------------------------------------ */

		const inject = [];

		function apply(ctx) {
			try {
				history = loadHistory();
				enabled = loadEnabled();
			} catch {
				/* ignore */
			}
			if (ctx && typeof ctx.effect === "function") {
				ctx.effect(() => {
					try {
						install();
					} catch (error) {
						reportDebug("install-error:" + String((error && error.message) || error));
					}
					return () => uninstall();
				}, "inline-suggest: composer ghost text");
			} else {
				try {
					install();
				} catch (error) {
					reportDebug("install-error:" + String((error && error.message) || error));
				}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
