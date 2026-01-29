const { Plugin, Notice } = require('obsidian');
const { exec } = require('child_process');
const path = require('path');

const SINGLE_REF_PATTERN = "[가-힣]+\\s*[0-9]+(?:[-~][0-9]+)?(?:[:장\\s]*[0-9]+(?:(?:-|~|,\\s*)[0-9]+)*)?(?:장|절)?";
const BIBLE_REGEX = new RegExp(`((?:${SINGLE_REF_PATTERN})(?:\\s*[,;]\\s*(?:${SINGLE_REF_PATTERN}))*)`, "g");
const SPLIT_REGEX = new RegExp(`(${SINGLE_REF_PATTERN})`, "g");
const REMOVE_AT_REGEX = /@([가-힣]+)\s*([0-9]+(?:[:장\s]*[0-9]+)?(?:(?:-|,\s*)[0-9]+)*)\s$/;

module.exports = class LocalBiblePlugin extends Plugin {
    closeTimer = null;
    openTimer = null;       
    currentHoverRef = null; 
    currentHoverIndex = -1; 
    isScrolling = false;    
    scrollEndTimer = null;
    
    settings = { highlights: {} };
    history = []; 

    async onload() {
        console.log('로컬 성경 플러그인 (스크롤 위치 고정 기능 탑재) 로드됨');
        
        await this.loadSettings();
        this.addStyle();

        this.registerDomEvent(document, 'keydown', async (evt) => {
            const popup = document.getElementById('bible-hover-popup');
            if (!popup) return;

            // 실행 취소 (Ctrl+Z / Cmd+Z)
            if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'z') {
                evt.preventDefault();
                await this.undoLastAction(popup);
                return;
            }

            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) return;

            const contentDiv = document.getElementById('bible-popup-content');
            if (!contentDiv || !contentDiv.contains(selection.anchorNode)) return;

            const selectedText = selection.toString().trim();
            if (!selectedText) return;

            // A: 저장
            if (evt.code === 'KeyA') {
                evt.preventDefault();
                await this.handleHighlightAction('save', selectedText, popup);
            }
            // D: 삭제
            else if (evt.code === 'KeyD') {
                evt.preventDefault();
                await this.handleHighlightAction('delete', selectedText, popup);
            }
        });

        this.addCommand({
            id: 'restart-bible-server',
            name: '성경 서버 재시작 (Restart Bible Server)',
            callback: () => this.restartServer()
        });
        
        this.addCommand({
            id: 'clear-bible-highlights',
            name: '성경 하이라이트 모두 지우기',
            callback: async () => {
                this.settings.highlights = {};
                this.history = [];
                await this.saveSettings();
                new Notice("모든 성경 하이라이트가 삭제되었습니다.");
            }
        });

        this.registerEvent(this.app.workspace.on('editor-change', (editor) => {
            const cursor = editor.getCursor();
            const lineText = editor.getLine(cursor.line);
            const textUpToCursor = lineText.substring(0, cursor.ch);
            const match = textUpToCursor.match(REMOVE_AT_REGEX);

            if (match) {
                const fullText = match[0];
                const cleanText = fullText.replace('@', ''); 
                const from = { line: cursor.line, ch: cursor.ch - fullText.length };
                const to = { line: cursor.line, ch: cursor.ch };
                editor.replaceRange(cleanText, from, to);
            }
        }));

        const handleScrollOrWheel = (evt) => {
            if (evt.target && evt.target.closest && evt.target.closest('#bible-hover-popup')) return; 
            this.isScrolling = true;
            this.cancelOpen(); 
            this.closePopup(); 
            if (this.scrollEndTimer) clearTimeout(this.scrollEndTimer);
            this.scrollEndTimer = setTimeout(() => { this.isScrolling = false; }, 300); 
        };

        this.registerDomEvent(document, 'scroll', handleScrollOrWheel, { capture: true });
        this.registerDomEvent(document, 'wheel', handleScrollOrWheel, { capture: true });

        this.registerDomEvent(document, 'mousemove', (evt) => {
            if (this.isScrolling) return; 
            if (evt.buttons > 0 && document.getElementById('bible-hover-popup')) { this.cancelClose(); return; }
            if (evt.target.closest('#bible-hover-popup')) { this.cancelClose(); this.cancelOpen(); return; }

            const range = this.getRangeAtCursor(evt);
            if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) { this.cancelOpen(); this.triggerClose(); return; }

            const textNode = range.startContainer;
            const fullText = textNode.textContent;
            
            BIBLE_REGEX.lastIndex = 0;
            let match;
            let found = false;
            
            while ((match = BIBLE_REGEX.exec(fullText)) !== null) {
                const start = match.index;
                const end = start + match[0].length;

                if (this.isMouseOverText(textNode, start, end, evt.clientX, evt.clientY)) {
                    const fullRefString = match[0].trim();
                    const relativeCursor = range.startOffset - start;
                    let targetIndex = 0; 
                    
                    const subMatches = [...fullRefString.matchAll(SPLIT_REGEX)];
                    for (let i = 0; i < subMatches.length; i++) {
                        const sub = subMatches[i];
                        const subEnd = sub.index + sub[0].length;
                        if (relativeCursor <= subEnd + 2) {
                            targetIndex = i;
                            break;
                        }
                    }
                    this.cancelClose(); 

                    const existingPopup = document.getElementById('bible-hover-popup');
                    if (existingPopup && this.currentHoverRef === fullRefString) {
                        if (this.currentHoverIndex !== targetIndex) {
                            this.currentHoverIndex = targetIndex;
                            this.switchTabInPopup(targetIndex);
                        }
                        found = true;
                        break;
                    }
                    if (this.currentHoverRef !== fullRefString) {
                        this.cancelOpen(); 
                        this.currentHoverRef = fullRefString;
                        this.currentHoverIndex = targetIndex; 
                        this.openTimer = setTimeout(() => {
                            if (this.isScrolling) return; 
                            this.fetchVersePopup(fullRefString, evt.pageX, evt.pageY, evt.clientX, evt.clientY, targetIndex);
                        }, 600); 
                    }
                    found = true;
                    break;
                }
            }
            if (!found) { this.cancelOpen(); this.currentHoverRef = null; this.currentHoverIndex = -1; this.triggerClose(); }
        });

        this.registerDomEvent(document, 'click', (evt) => {
             if (evt.target.closest('#bible-hover-popup')) return;
             this.closePopup();
        });

        this.registerMarkdownPostProcessor((element, context) => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
            let node;
            while (node = walker.nextNode()) {
                const text = node.textContent;
                if (BIBLE_REGEX.test(text)) {
                    const span = document.createElement('span');
                    span.innerHTML = text.replace(BIBLE_REGEX, (match) => { return `<span class="bible-ref-link">${match}</span>`; });
                    node.parentNode.replaceChild(span, node);
                }
            }
        });
    }

    async handleHighlightAction(action, selectedText, popup) {
        const activeBtn = popup.querySelector('.bible-tab-btn.active');
        if (!activeBtn) return;
        
        const key = activeBtn.innerText; 
        
        if (!this.settings.highlights[key]) {
            this.settings.highlights[key] = [];
        }

        const previousState = [...this.settings.highlights[key]];
        this.history.push({ key: key, highlights: previousState });
        if (this.history.length > 30) this.history.shift(); 

        let changed = false;

        if (action === 'save') {
            if (!this.settings.highlights[key].includes(selectedText)) {
                this.settings.highlights[key].push(selectedText);
                changed = true;
                new Notice("하이라이트 생성됨");
            } else {
                this.history.pop(); 
                new Notice("이미 생성된 하이라이트입니다");
            }
        } else if (action === 'delete') {
            const initialCount = this.settings.highlights[key].length;
            this.settings.highlights[key] = this.settings.highlights[key].filter(savedHighlight => {
                return !selectedText.includes(savedHighlight);
            });

            if (this.settings.highlights[key].length < initialCount) {
                changed = true;
                new Notice("하이라이트 제거됨");
            } else {
                this.history.pop(); 
                new Notice("제거할 하이라이트가 없습니다");
            }
        }

        if (changed) {
            await this.saveSettings();
            // [핵심] 여기서 탭 변경이 아니라 '내용만 리로드'를 호출 (스크롤 유지)
            if (popup.reloadCurrentContent) {
                popup.reloadCurrentContent();
            }
        }
    }

    async undoLastAction(popup) {
        if (this.history.length === 0) {
            new Notice("되돌릴 작업이 없습니다");
            return;
        }

        const lastState = this.history.pop();
        const { key, highlights } = lastState;

        this.settings.highlights[key] = highlights;
        await this.saveSettings();
        
        new Notice("실행 취소됨");

        // Undo도 스크롤 유지하며 갱신
        if (popup.reloadCurrentContent) {
            popup.reloadCurrentContent();
        }
    }

    async loadSettings() {
        const loadedData = await this.loadData();
        this.settings = Object.assign({}, { highlights: {} }, loadedData);
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }

    restartServer() {
        new Notice("🔄 성경 서버 재시작을 시도합니다...");
        const vaultPath = this.app.vault.adapter.basePath; 
        const serverDir = path.join(vaultPath, '_BibleServer');
        let command = "";
        if (process.platform === "darwin") {
            const scriptPath = path.join(serverDir, "bible_start.command");
            command = `pkill -f uvicorn; open "${scriptPath}"`;
        } else if (process.platform === "win32") {
            const scriptPath = path.join(serverDir, "bible_ghost.vbs");
            command = `taskkill /F /IM python.exe /T & wscript "${scriptPath}"`;
        }
        exec(command, (error, stdout, stderr) => {
            if (error) console.error(`Error: ${error.message}`);
            setTimeout(() => { new Notice("✅ 성경 서버가 재시작되었습니다!"); }, 2000);
        });
    }

    switchTabInPopup(index) {
        const popup = document.getElementById('bible-hover-popup');
        if (!popup) return;
        const buttons = popup.querySelectorAll('.bible-tab-btn');
        if (buttons && buttons[index]) {
            buttons[index].click();
        }
    }

    async fetchVersePopup(fullRefString, pageX, pageY, clientX, clientY, targetIndex = 0) {
        const existingPopup = document.getElementById('bible-hover-popup');
        if (existingPopup && existingPopup.dataset.ref === fullRefString) return;

        try {
            const individualRefs = fullRefString.match(SPLIT_REGEX) || [fullRefString];
            
            const promises = individualRefs.map(ref => 
                fetch(`http://127.0.0.1:8000/search?query=${encodeURIComponent(ref)}`)
                    .then(res => res.json())
                    .then(data => ({ ref, data }))
                    .catch(() => null)
            );

            const results = await Promise.all(promises);
            let allTabs = [];

            results.forEach(result => {
                if (result && result.data.items && result.data.items.length > 0) {
                    result.data.items.forEach(item => {
                        if (item.subtitle && item.subtitle.startsWith("Enter:")) {
                            allTabs.push({
                                label: item.title,
                                content: item.arg,
                                footer: item.footer_text,
                                storageKey: item.pure_ref || item.title
                            });
                        }
                    });
                }
            });

            if (allTabs.length > 0) {
                if (targetIndex >= allTabs.length) targetIndex = 0;
                this.showTabbedPopup(allTabs, pageX, pageY, clientX, clientY, fullRefString, targetIndex);
            }

        } catch (e) {
            console.error(e);
        }
    }

    showTabbedPopup(tabs, pageX, pageY, clientX, clientY, ref, activeIndex = 0) {
        this.closePopup();
        const popup = this.createPopupBase(ref);
        
        const tabHeader = document.createElement('div');
        tabHeader.className = 'bible-tabs-container';
        
        const contentDiv = document.createElement('div');
        contentDiv.id = 'bible-popup-content';
        contentDiv.style.cssText = `
            word-break: keep-all; white-space: pre-wrap; flex-grow: 1; overflow-y: auto; 
            padding-right: 5px; padding-bottom: 30px; min-height: 0;
            user-select: text; -webkit-user-select: text; cursor: text;
        `;
        
        const scrollStyle = document.createElement('style');
        scrollStyle.innerHTML = `
            #bible-popup-content::-webkit-scrollbar { width: 8px; } 
            #bible-popup-content::-webkit-scrollbar-track { background: #2a2a2a; } 
            #bible-popup-content::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; } 
            #bible-popup-content::-webkit-scrollbar-thumb:hover { background: #ffab70; }
            #bible-popup-content::selection { background-color: #f8fcbd; color: #202020; }
            .bible-highlight { background-color: #f8fcbd; color: #202020; border-radius: 2px; }
        `;
        contentDiv.appendChild(scrollStyle);

        const initialTab = tabs[activeIndex];
        const initialFooterText = initialTab.footer ? `${initialTab.footer} KRV` : `${initialTab.label} KRV`;
        const footer = this.createFooter(initialFooterText);

        // [핵심 변경] renderContent 함수가 스크롤 유지 옵션을 받음
        let currentTabIndex = activeIndex;

        const renderContent = (tab, keepScroll = false) => {
            const prevScrollTop = contentDiv.scrollTop; // 현재 스크롤 저장

            const key = tab.label;
            const savedHighlights = this.settings.highlights[key] || [];
            const html = this.applyHighlights(tab.content, savedHighlights);
            
            const styleEl = contentDiv.querySelector('style');
            contentDiv.innerHTML = '';
            if(styleEl) contentDiv.appendChild(styleEl);
            
            const textSpan = document.createElement('span');
            textSpan.innerHTML = html;
            contentDiv.appendChild(textSpan);
            
            // [스크롤 복구 로직]
            if (keepScroll) {
                contentDiv.scrollTop = prevScrollTop;
            } else {
                contentDiv.scrollTop = 0;
            }
            
            footer.innerText = tab.footer ? `${tab.footer} KRV` : `${tab.label} KRV`;
        };

        // 외부(handleHighlightAction)에서 호출할 수 있는 리로드 함수 부착
        popup.reloadCurrentContent = () => {
            renderContent(tabs[currentTabIndex], true); // true = 스크롤 유지!
        };

        tabs.forEach((tab, index) => {
            const btn = document.createElement('button');
            btn.className = 'bible-tab-btn';
            btn.innerText = tab.label; 
            
            if (index === activeIndex) btn.classList.add('active');

            btn.onclick = () => {
                tabHeader.querySelectorAll('.bible-tab-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentTabIndex = index; 
                renderContent(tab, false); // 탭 변경 시에는 스크롤 초기화 (false)
            };
            tabHeader.appendChild(btn);
        });

        renderContent(initialTab, false);
        
        if (tabs.length > 0) popup.appendChild(tabHeader);
        popup.appendChild(contentDiv);
        popup.appendChild(footer);
        
        document.body.appendChild(popup);
        this.adjustPopupPosition(popup, pageX, pageY, clientX, clientY);
    }

    applyHighlights(text, highlights) {
        if (!highlights || highlights.length === 0) return text;
        let html = text;
        highlights.forEach(word => {
            const escapedWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(${escapedWord})`, 'g');
            html = html.replace(regex, '<span class="bible-highlight">$1</span>');
        });
        return html;
    }

    createPopupBase(ref) {
        const popup = document.createElement('div');
        popup.id = 'bible-hover-popup';
        popup.dataset.ref = ref;
        popup.addEventListener('mouseenter', () => this.cancelClose());
        popup.addEventListener('mouseleave', () => this.triggerClose());
        popup.style.cssText = `
            position: absolute; z-index: 1000; background-color: #202020; 
            border: 1px solid #ffab70; padding: 15px; border-radius: 8px; 
            box-shadow: 0 4px 15px rgba(0,0,0,0.6); 
            width: 500px; max-width: 90vw; max-height: 50vh; 
            display: flex; flex-direction: column;
            pointer-events: auto; color: #e0e0e0; font-family: sans-serif; 
            line-height: 1.6; visibility: hidden;
            user-select: text; -webkit-user-select: text;
        `;
        return popup;
    }

    createFooter(initialText) {
        const footerDiv = document.createElement('div');
        footerDiv.style.cssText = `font-size: 0.85em; color: #ffab70; text-align: right; border-top: 1px solid #444; padding-top: 8px; margin-top: 8px; flex-shrink: 0;`;
        footerDiv.innerText = initialText;
        return footerDiv;
    }

    adjustPopupPosition(popup, pageX, pageY, clientX, clientY) {
        const popupHeight = popup.offsetHeight;
        const popupWidth = popup.offsetWidth;
        const windowHeight = window.innerHeight;
        const windowWidth = window.innerWidth;
        let topPos = (windowHeight - clientY < popupHeight + 20) ? pageY - popupHeight - 20 : pageY + 20;
        let leftPos = (clientX + popupWidth > windowWidth - 20) ? pageX - popupWidth : pageX;
        if (leftPos < 0) leftPos = 20;
        if (topPos < 20) topPos = 20;
        popup.style.top = `${topPos}px`;
        popup.style.left = `${leftPos}px`;
        popup.style.visibility = 'visible';
    }

    addStyle() {
        const style = document.createElement('style');
        style.innerHTML = `
            .bible-ref-link { color: #ffab70; text-decoration: underline; text-underline-offset: 3px; cursor: help; }
            .bible-tabs-container { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; border-bottom: 1px solid #444; padding-bottom: 5px; flex-shrink: 0; }
            .bible-tab-btn { background: #333; border: 1px solid #555; color: #aaa; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 0.85em; }
            .bible-tab-btn:hover { background: #444; color: #fff; }
            .bible-tab-btn.active { background: #ffab70; color: #202020; border-color: #ffab70; font-weight: bold; }
        `;
        document.head.appendChild(style);
    }
    
    getRangeAtCursor(evt) { return document.caretRangeFromPoint ? document.caretRangeFromPoint(evt.clientX, evt.clientY) : null; }
    isMouseOverText(textNode, startOffset, endOffset, mouseX, mouseY) {
        try {
            const range = document.createRange();
            range.setStart(textNode, startOffset);
            range.setEnd(textNode, endOffset);
            const rects = range.getClientRects();
            for (const rect of rects) {
                if (mouseX >= rect.left && mouseX <= rect.right && mouseY >= rect.top && mouseY <= rect.bottom) return true;
            }
        } catch (e) { return false; }
        return false;
    }
    cancelClose() { if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; } }
    triggerClose() { if (!this.closeTimer) this.closeTimer = setTimeout(() => this.closePopup(), 300); }
    closePopup() { 
        const el = document.getElementById('bible-hover-popup'); 
        if(el) el.remove(); 
        this.closeTimer = null; 
        this.cancelOpen(); 
        this.currentHoverRef = null;
        this.currentHoverIndex = -1; 
    }
    cancelOpen() { if(this.openTimer) { clearTimeout(this.openTimer); this.openTimer = null; } }
    onunload() { this.closePopup(); }
};