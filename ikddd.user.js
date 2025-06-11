// ==UserScript==
// @name         irankhodrodisel
// @namespace    http://tampermonkey.net/
// @version      2025-06-13.03
// @description  Redesigned the found product card to be more compact, modern, and visually appealing. Added scroll to captcha. Improved mobile responsiveness and collapsible settings, and refined product search logic with advanced text normalization and selection. This version features a dark mode with neumorphic accents and a fixed layout for message/captcha boxes.
// @author       Masoud
// @match        https://esale.ikd.ir/*
// @icon         https://esale.ikd.ir/logo.png
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_info
// @require      https://cdn.jsdelivr.net/npm/axios/dist/axios.min.js
// ==/UserScript==

(function() {
    'use strict';

    // =====================================================================================
    // --- ⚙️ CONFIGURATION & CONSTANTS ---
    // =====================================================================================

    const CONFIG = {
        localStorageTokenKey: 'SaleInternet',
        smsTimestampKey: 'ikdBotSmsTimestamp',
        apiBaseUrl: 'https://esale.ikd.ir/api',
        relayServerBaseUrl: 'https://smsikd.sipa-solver.shop',
        remoteSolverUrl1: 'https://ikd.sipa-solver.shop/solve_captcha',
        remoteSolverUrl2: 'https://oikd.sipa-solver.shop/solve',
        defaultMobileNumber: '09000000000',

        smsCooldownMinutes: 5,
        searchPollingIntervalMs: 2500,
        smsRelayPollingIntervalMs: 1500,
        logoImageUrl: 'https://esale.ikd.ir/logo.png',
        closeIconText: '&times;',
        triggerButtonText: 'فعال‌سازی ربات',
        popupSearchPlaceholder: 'نام دقیق محصول مورد نظر',
        startContinuousSearchText: 'شروع جستجو',
        stopContinuousSearchText: 'توقف جستجو',
        manualSmsButtonText: 'کد SMS دستی',
        manualSmsCooldownText: 'صبر کنید: {timeLeft}',
        saveMobileButtonText: 'ذخیره',
        updateButtonText: 'به‌روزرسانی',
        botVersion: 'v5.0.0', // Updated version name

        fixedDelays: {
            // تأخیر قبل از ارسال درخواست‌های API اصلی
            apiDelayMs: 3000,
            // تأخیر هنگام تلاش مجدد پس از خطای عمومی
            retryDelayMs: 500,
            // تأخیر هنگام تلاش مجدد پس از خطای ثبت سفارش
            submitFailedDelayMs: 500,
            // تأخیر بین تلاش‌های مجدد برای حل کپچا
            captchaRetryDelayMs: 500,
            // تأخیر برای شبیه‌سازی کلیک
            clickDelayMs: 150
        },

        autoSolverConfig: {
            solverOrder: ['solver-2', 'solver-1'],
            maxCaptchaSolveRetries: 3
        },

        manualInputConfig: {
            minApiDelayMs: 50,
            maxApiDelayMs: 200,
            minRetryDelayMs: 500,
            maxRetryDelayMs: 2000,
            minSubmitFailedDelayMs: 1000,
            maxSubmitFailedDelayMs: 3000,
        }
    };
    const API_ENDPOINTS_IKD = {
        getSaleProjects: `${CONFIG.apiBaseUrl}/sales/getSaleProjects`,
        getCaptchaOrder: `${CONFIG.apiBaseUrl}/esales/getCaptchaOrder`,
        readSefareshInfo: `${CONFIG.apiBaseUrl}/esales/readSefareshInfo`,
        sendSmsOrder: `${CONFIG.apiBaseUrl}/users/sendSmsOrder`,
        addSefaresh: `${CONFIG.apiBaseUrl}/esales/addSefaresh`,
    };
    // =====================================================================================
    // --- 🖼️ GLOBAL STATE & UI ELEMENTS ---
    // =====================================================================================
    let authToken = "";
    let uiElements = {};
    let mobileNumber = CONFIG.defaultMobileNumber;
    let currentOrderData = {};
    let smsRelayPollingTimeoutId = null;
    let mainProcessTimeoutId = null;
    let smsCooldownInterval = null;
    let productSearchPollingTimeoutId = null;
    let isContinuousSearchingProduct = false;
    let selectedSolver = 'solver-2';
    const getSimulatedHeaders = (refererPage, withPriority) => {

        let refererUrl;
        if (refererPage === 'products') {
            refererUrl = 'https://esale.ikd.ir/products';
        } else {
            refererUrl = 'https://esale.ikd.ir/addOrder';
        }

        const headers = {
            'User-Agent': navigator.userAgent,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.5',
            'authorization': `Bearer ${authToken}`,
            'Origin': 'https://esale.ikd.ir',
            'Connection': 'keep-alive',
            'Referer': refererUrl,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
        };
        if (withPriority) {
            headers['Priority'] = 'u=0';
        }
        return headers;
    };
    function getActiveConfig() {
        return selectedSolver === 'solver-none' ? CONFIG.manualInputConfig : CONFIG.autoSolverConfig;
    }

    window.onerror = function(message, source, lineno, colno, error) {
        log('error', 'یک خطای پیش‌بینی نشده در سطح اسکریپت رخ داد!', { message, source, lineno, colno, error });
        if (uiElements.systemMessagesContent) {
            displayMessage('خطای بحرانی! تلاش برای راه‌اندازی مجدد...', 'error');
        }
        setTimeout(() => {
            if (currentOrderData.selectedProject && !currentOrderData.isSubmittingOrderProcess) {
                startOrderProcess();
            }
        }, getRandomDelay(getActiveConfig().minRetryDelayMs, getActiveConfig().maxRetryDelayMs));
        return true;
    };

    // =====================================================================================
    // --- 🛠️ UTILITY FUNCTIONS ---
    // =====================================================================================
    function normalizeTextForSearch(text) {
        if (!text) return '';
        return text.toString().toLowerCase().replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک').replace(/\u200C/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
    }

    function log(type, message, data) {
        const prefix = { info: '[INFO]', error: '[ERROR]', success: '[موفق]', warn: '[هشدار]', debug: '[DEBUG]' }[type] || '[LOG]';
        if (data !== undefined) console[type === 'error' ? 'error' : 'log'](`${prefix} ${message}`, data);
        else console[type === 'error' ? 'error' : 'log'](`${prefix} ${message}`);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function getRandomDelay(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16).toUpperCase();
        });
    }

    function handleApiError(error, apiName) {
        const msg = error.response ? (error.response.data?.message || JSON.stringify(error.response.data) || error.message) : error.message;
        log('error', `${apiName} API Fail:`, msg);
        return { success: false, data: null, error: msg || "Unknown API error" };
    }

    function captchaDataToFile(captchaData) {
        if (captchaData.dataImage) {
            return base64ToFile(`data:image/png;base64,${captchaData.dataImage}`, "captcha.png");
        } else if (captchaData.capchaData && captchaData.capchaData.toLowerCase().includes("<svg")) {
            return new File([captchaData.capchaData], 'captcha.svg', {type: 'image/svg+xml'});
        }
        return null;
    }

    function base64ToFile(base64String, filename) {
        try {
            if(!base64String || !base64String.startsWith('data:')) return null;
            const parts = base64String.split(',');
            if (parts.length < 2) return null;
            const byteCharacters = atob(parts[1]);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
            const byteArray = new Uint8Array(byteNumbers);
            return new File([byteArray], filename, { type: parts[0].substring(parts[0].indexOf(':') + 1, parts[0].indexOf(';')) || 'image/png' });
        } catch (e) {
            log('error','خطا در تبدیل Base64 به فایل.', e);
            return null;
        }
    }

    function findClosestMatch(searchTerm, saleProjects) {
        if (!searchTerm || !Array.isArray(saleProjects) || saleProjects.length === 0) {
            return null;
        }

        const normalizedSearchTerm = normalizeTextForSearch(searchTerm);
        function levenshteinDistance(str1, str2) {
            const len1 = str1.length, len2 = str2.length;
            const dp = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));
            for (let i = 0; i <= len1; i++) dp[i][0] = i;
            for (let j = 0; j <= len2; j++) dp[0][j] = j;
            for (let i = 1; i <= len1; i++) {
                for (let j = 1; j <= len2; j++) {
                    dp[i][j] = str1[i - 1] === str2[j - 1] ? dp[i - 1][j - 1] : Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
                }
            }
            return dp[len1][len2];
        }

        function damerauLevenshtein(str1, str2) {
            const len1 = str1.length, len2 = str2.length;
            const dp = Array.from({ length: len1 + 1 }, () => Array(len2 + 1).fill(0));
            for (let i = 0; i <= len1; i++) dp[i][0] = i;
            for (let j = 0; j <= len2; j++) dp[0][j] = j;
            for (let i = 1; i <= len1; i++) {
                for (let j = 1; j <= len2; j++) {
                    let cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
                    if (i > 1 && j > 1 && str1[i - 1] === str2[j - 2] && str1[i - 2] === str2[j - 1]) {
                        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
                    }
                }
            }
            return dp[len1][len2];
        }

        function jaccardSimilarity(str1, str2) {
            const set1 = new Set(str1.split(" "));
            const set2 = new Set(str2.split(" "));
            const intersection = new Set([...set1].filter(word => set2.has(word)));
            const union = set1.size + set2.size - intersection.size;
            return union === 0 ? 1 : intersection.size / union;
        }

        function nGramSimilarity(str1, str2, n = 2) {
            if (!str1 || !str2 || str1.length < n || str2.length < n) return 0;
            const getNGrams = s => new Set(Array.from({ length: s.length - n + 1 }, (_, i) => s.substr(i, n)));
            const ngrams1 = getNGrams(str1);
            const ngrams2 = getNGrams(str2);
            const intersection = [...ngrams1].filter(g => ngrams2.has(g)).length;
            const union = ngrams1.size + ngrams2.size - intersection;
            return union === 0 ? 1 : intersection / union;
        }

        let bestMatch = null;
        let highestScore = -Infinity;
        for (const project of saleProjects) {
            const combinedTitle = `${project.Title || ''} ${project.KhodroTitle || ''}`;
            if (!combinedTitle) continue;
            const normalizedCombinedTitle = normalizeTextForSearch(combinedTitle);
            const levDist = levenshteinDistance(normalizedSearchTerm, normalizedCombinedTitle);
            const damLevDist = damerauLevenshtein(normalizedSearchTerm, normalizedCombinedTitle);
            const jaccardScore = jaccardSimilarity(normalizedSearchTerm, normalizedCombinedTitle);
            const ngramScore = nGramSimilarity(normalizedSearchTerm, normalizedCombinedTitle);
            const maxLen = Math.max(normalizedSearchTerm.length, normalizedCombinedTitle.length);
            const normalizedLev = maxLen === 0 ? 1 : 1 - (levDist / maxLen);
            const normalizedDamLev = maxLen === 0 ? 1 : 1 - (damLevDist / maxLen);
            const finalScore = (normalizedLev * 0.35 + normalizedDamLev * 0.35 + jaccardScore * 0.2 + ngramScore * 0.1);
            if (finalScore > highestScore) {
                highestScore = finalScore;
                bestMatch = project;
            }
        }
        return bestMatch;
    }

    // --- Simulate Typing Function (ONLY for CAPTCHA now) ---
    // --- تابع جدید برای درج آنی مقدار ---
    async function simulateTyping(element, text) {
        if (!element) return;

        // 1. فوکوس روی کادر ورودی
        element.focus();

        // 2. درج آنی مقدار کامل
        element.value = text;

        // 3. ارسال رویدادها برای اینکه سایت متوجه تغییر شود
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));

        // 4. برداشتن فوکوس از کادر
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    // --- NEW FUNCTION: Simulate Click ---
    async function simulateClick(element, minDelay = 150, maxDelay = 250) {
        if (!element) {
            log('warn', 'تلاش برای شبیه‌سازی کلیک روی المان نامعتبر.');
            return;
        }

        // تمرکز (focus) روی المان قبل از کلیک (رفتار طبیعی کاربر)
        if (typeof element.focus === 'function') {
            element.focus();
            await sleep(getRandomDelay(minDelay / 2, maxDelay / 2)); // مکث کوتاه بعد از فوکوس
        }

        // شبیه سازی mouseDown
        element.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true
            // view: window // این خط را حذف کنید
        }));
        await sleep(getRandomDelay(minDelay, maxDelay)); // مکث بین mousedown و mouseup

        // شبیه سازی mouseup
        element.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true
            // view: window // این خط را حذف کنید
        }));
        await sleep(getRandomDelay(minDelay, maxDelay)); // مکث بین mouseup و click

        // شبیه سازی click
        element.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true
            // view: window // این خط را حذف کنید
        }));
        await sleep(getRandomDelay(minDelay, maxDelay)); // مکث کوتاه بعد از کلیک

        // از دست دادن تمرکز (blur) بعد از کلیک (رفتار طبیعی کاربر)
        if (typeof element.blur === 'function') {
            element.blur();
        }
    }


    // =====================================================================================
    // --- 📞 API CALL FUNCTIONS ---
    // =====================================================================================
    async function getSaleProjectsFromIKD() {
        try {
            const headers = { ...getSimulatedHeaders('products', false), 'Content-Type': 'application/json; charset=UTF-8' };
            const response = await axios.post(API_ENDPOINTS_IKD.getSaleProjects, {}, { headers });
            return { success: true, data: response.data };
        } catch (error) {
            return handleApiError(error, 'getSaleProjectsFromIKD');
        }
    }

    async function getOrderDetailsFromIKD(projectData) {
        const payload = { idDueDeliverProg: projectData.IdDueDeliverProg };
        try {
            const headers = { ...getSimulatedHeaders('addOrder', true), 'Content-Type': 'application/json; charset=UTF-8' };
            const response = await axios.post(API_ENDPOINTS_IKD.readSefareshInfo, payload, { headers, withCredentials: true });
            if (response.data && response.data.statusResult === 0 && response.data.rows?.length) {
                const randomRow = response.data.rows[Math.floor(Math.random() * response.data.rows.length)];
                // در اینجا agencyId از خود نمایندگی رندوم برداشته می‌شود
                return { success: true, data: { agencyId: randomRow.value, selectedUsage: response.data.usages?.[0]?.value || null, selectedColor: response.data.colors?.[0]?.value || null, agency: randomRow, } };
            }
            return { success: false, error: response.data.message || 'اطلاعات نمایندگی دریافت نشد.' };
        } catch (error) {
            return handleApiError(error, 'getOrderDetailsFromIKD');
        }
    }

    async function getCaptchaOrderFromIKD(cardId, previousToken = "") {
        const payload = { "captchaName": "Order", "token": previousToken, "captchaId": parseInt(cardId), "apiId": "06290E83-E12E-4910-9C12-942F78131CE6" };
        try {
            const hasPriority = !previousToken;
            const headers = { ...getSimulatedHeaders('addOrder', hasPriority), 'Content-Type': 'application/json;   charset=UTF-8' };
            const response = await axios.post(API_ENDPOINTS_IKD.getCaptchaOrder, payload, { headers, withCredentials: true });
            if (response.data && response.data.statusResult === 0 && (response.data.dataImage || response.data.capchaData)) {
                return { success: true, data: response.data };
            }
            return { success: false, error: response.data.message || "پاسخ سرور فاقد تصویر کپچا بود." };
        } catch (error) {
            return handleApiError(error, 'getCaptchaOrderFromIKD');
        }
    }

    async function requestSmsFromIKD() {
        const lastSmsTime = parseInt(localStorage.getItem(CONFIG.smsTimestampKey) || '0');
        const now = Date.now();
        const cooldownMs = CONFIG.smsCooldownMinutes * 60 * 1000;
        if (now - lastSmsTime < cooldownMs) {
            const timeLeftMs = cooldownMs - (now - lastSmsTime);
            return { success: false, error: `محدودیت زمانی ارسال SMS.`, isCooldown: true, timeLeftMs };
        }
        const payload = { smsType: "Order", systemCode: "SaleInternet", idDueDeliverProg: currentOrderData.selectedProject?.IdDueDeliverProg };
        try {
            const headers = { ...getSimulatedHeaders('addOrder', true), 'Content-Type': 'application/json; charset=UTF-8' };
            const response = await axios.post(API_ENDPOINTS_IKD.sendSmsOrder, payload, { headers, withCredentials: true });
            if (response.data && response.data.statusResult === 0) {
                localStorage.setItem(CONFIG.smsTimestampKey, Date.now());
                return { success: true };
            }
            return { success: false, error: response.data.message || "خطا در ارسال SMS" };
        } catch (error) {
            return handleApiError(error, 'requestSmsFromIKD');
        }
    }

    async function addOrderToIKD(orderPayload) {
        await sleep(CONFIG.fixedDelays.apiDelayMs);
        try {
            const headers = { ...getSimulatedHeaders('addOrder', true), 'Content-Type': 'application/json; charset=UTF-8' };
            console.log("--- آماده‌سازی برای ارسال addSefaresh ---");
            console.log("مقدار Referer که به axios ارسال می‌شود:", headers.Referer);
            console.log("شیء کامل هدرها:", headers);
            const r = await axios.post(API_ENDPOINTS_IKD.addSefaresh, orderPayload, { headers, withCredentials: true });
            if (r.data && r.data.identity) {
                const f = document.createElement('form');
                f.method = 'POST';
                f.action = 'https://ikc.shaparak.ir/iuiv3/IPG/Index';
                const i = document.createElement('input');
                i.type = 'hidden';
                i.name = 'tokenIdentity';
                i.value = r.data.identity;
                f.appendChild(i);
                document.body.appendChild(f);
                f.submit();
                return { success: true };
            }
            return { success: false, error: r.data.message || "خطا در ثبت نهایی سفارش" };
        } catch (e) {
            return handleApiError(e, 'addOrderToIKD');
        }
    }

    async function solveCaptcha(captchaData) {
        const captchaFile = captchaDataToFile(captchaData);
        if (!captchaFile) return { success: false, error: "فایل کپچا برای حل موجود نیست." };
        const activeConfig = getActiveConfig();
        const definedSolvers = {
            'solver-1': { name: 'سرور ۱ (عمومی)', url: CONFIG.remoteSolverUrl1 },
            'solver-2': { name: 'سرور ۲ (شخصی)', url: CONFIG.remoteSolverUrl2 }
        };
        const solversToTry = activeConfig.solverOrder?.map(key => definedSolvers[key]).filter(Boolean) || (definedSolvers[selectedSolver] ? [definedSolvers[selectedSolver]] : []);
        if (solversToTry.length === 0) return { success: false, error: "حل‌کننده انتخاب شده در دسترس نیست یا تنظیم نشده است." };
        for (const solver of solversToTry) {
            try {
                log('info', `تلاش برای حل کپچا با سرور: ${solver.name}`);
                const formData = new FormData();
                formData.append('file', captchaFile);
                const response = await axios.post(solver.url, formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 15000 });
                const answer = response.data?.answer || response.data?.solved_value || response.data?.solve || (typeof response.data === 'string' && response.data);
                if (answer) {
                    const lowerCaseAnswer = String(answer).toLowerCase();
                    log('success', `حل‌کننده ${solver.name} پاسخ داد: ${lowerCaseAnswer}`);
                    return { success: true, answer: lowerCaseAnswer };
                }
                log('warn', `پاسخ از حل‌کننده ${solver.name} نامعتبر است.`, response.data);
            } catch (e) {
                log('warn', `حل‌کننده ${solver.name} با خطا مواجه شد.`);
            }
        }
        return { success: false, error: 'هیچ‌کدام از حل‌کننده‌ها موفق به پاسخ نشدند.' };
    }

    async function getLastSmsFromRelayServer() {
        await sleep(100);
        try {
            const response = await axios.get(`${CONFIG.relayServerBaseUrl}/get-sms/${mobileNumber}`);
            if (response.data && response.data.success && response.data.smsCode) {
                return { success: true, sms: response.data.smsCode };
            }
            return { success: false, error: response.data.message || 'کد SMS یافت نشد.' };
        } catch (error) {
            if (error.response?.status === 404) return { success: false, error: 'کد SMS هنوز موجود نیست.' };
            return handleApiError(error, 'getLastSmsFromRelayServer');
        }
    }

    // =====================================================================================
    // --- 🎨 UI FUNCTIONS ---
    // =====================================================================================
    function createTriggerButton() {
        if (document.getElementById('ikd-bot-trigger-btn')) return;
        const b = document.createElement('button');
        b.id = 'ikd-bot-trigger-btn';
        b.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" viewBox="0 0 16 16"><path d="M12.17 9.53c2.307-2.592 3.278-4.684 3.641-6.218.21-.887.214-1.58.16-2.065a3.578 3.578 0 0 0-.108-.523.5.5 0 0 0-.048-.095.35.35 0 0 0-.06-.064.5.5 0 0 0-.098-.045c-.235-.073-.55-.13-.9-.13a.6.6 0 0 0-.25.038.5.5 0 0 0-.256.235c-.058.088-.12.193-.186.311.034.025.069.052.102.083.212.198.39.43.538.695.14.25.25.514.326.791.072.26.126.54.162.833.036.294.053.62.053.966.001.345-.016.68-.053.986-.034.277-.087.556-.16.837-.074.282-.182.564-.32.83-.134.258-.31.503-.51.732a.5.5 0 0 0-.023.029c-.19.224-.39.423-.604.59.043.023.086.046.128.069.135.073.28.132.43.176.15.044.31.075.472.092.164.017.33.02.498.006.17-.014.336-.04.5-.078.163-.038.324-.087.478-.145.155-.057.306-.126.45-.204.145-.078.285-.164.418-.258.134-.094.26-.2.38-.314.12-.114.23-.234.332-.36.103-.125.196-.258.28-.396.084-.138.16-.28.226-.425a.5.5 0 0 0-.12-.63Z"/><path d="M9.42 6.136c.215.216.215.564 0 .78l-3.32 3.32a.56.56 0 0 1-.779 0l-1.56-1.56a.56.56 0 0 1 0-.78l3.32-3.32a.56.56 0 0 1 .78 0l1.56 1.56Z"/><path d="M6.012 10.148.446 15.71c-.534.534-.075 1.485.656 1.485.434 0 .86-.19 1.14-.47l4.528-4.528a.56.56 0 0 1 .78 0l1.56 1.56a.56.56 0 0 1 0 .78l-4.528 4.528c-.28.28-.706.47-1.14.47-.73 0-1.19-.95-6.56-1.484a.5.5 0 0 1-.47-.66L5.232 10.93a.56.56 0 0 1 .78 0Z"/></svg><span>${CONFIG.triggerButtonText}</span>`;
        document.body.appendChild(b);
        b.addEventListener('click', () => { if (uiElements.mainPopup) { uiElements.mainPopup.style.display = 'flex'; resetPopupUI(); } });
    }

    function resetPopupUI() {
        if (isContinuousSearchingProduct) stopContinuousProductSearch();
        stopMainProcess();
        currentOrderData = { captchaAutoFilled: false, smsAutoFilled: false, isSubmittingOrderProcess: false, captchaToken: null, selectedProject: null, captchaCode: null, smsCode: null, stopProcess: false, orderDetails: null, initialSmsRequestSent: false };
        if (uiElements.initialSearchSection) uiElements.initialSearchSection.style.display = 'flex';
        if (uiElements.searchResultsSection) uiElements.searchResultsSection.style.display = 'none';
        if (uiElements.captchaSmsContainer) uiElements.captchaSmsContainer.style.display = 'none';
        if (uiElements.systemMessagesContent) uiElements.systemMessagesContent.innerHTML = `<p class="no-message-exist">برای شروع، مدل خودرو را وارد و جستجو کنید.<br>ربات از شماره <strong>${mobileNumber}</strong> برای SMS استفاده خواهد کرد.</p>`;
        if (uiElements.modelSearchInput) uiElements.modelSearchInput.value = '';
        if (uiElements.captchaInput) uiElements.captchaInput.value = '';
        if (uiElements.smsInput) uiElements.smsInput.value = '';
        if (uiElements.startSearchButton) { uiElements.startSearchButton.disabled = false; uiElements.startSearchButton.textContent = CONFIG.startContinuousSearchText; }
        if (uiElements.submitOrderButton) uiElements.submitOrderButton.disabled = true;
        if (uiElements.mobileInputPanel) uiElements.mobileInputPanel.style.display = 'none';
        checkSmsCooldownOnLoad();
        if (uiElements.settingsContent && uiElements.toggleSettingsButton) {
            const isMobileView = window.matchMedia("(max-width: 991px)").matches;
            uiElements.settingsContent.style.display = isMobileView ? 'none' : 'block';
            uiElements.toggleSettingsButton.classList.toggle('open', !isMobileView);
        }
    }

    function createMainPopupUI() {
        if (document.getElementById('ikd-main-process-popup')) return;
        const popup = document.createElement('div');
        popup.classList.add('popup');
        popup.id = 'ikd-main-process-popup';
        popup.style.display = 'none';
        popup.innerHTML = `
        <div class="popup-content-wrapper">
            <div class="popup-header">
                <div class="popup-header-left">
                    <img src="${CONFIG.logoImageUrl}" alt="لوگو" class="popup-logo"/>
                    <h2 class="popup-title">خرید ایران‌خودرو دیزل</h2>

                </div>
                <div class="popup-header-right">
                    <div class="header-info-item">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-phone-fill" viewBox="0 0 16 16"><path d="M3 2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V2zm6 11a1
1 0 1 0-2 0 1 1 0 0 0 2 0z"/></svg>
                        <span id="user-display-name">${mobileNumber}</span>
                    </div>
                    <div class="header-info-item">

                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M8 3.5a.5.5 0 0 0-1 0V9a.5.5 0 0 0 .252.434l3.5 2a.5.5 0 0 0 .496-.868L8 8.71z"/></svg>
                        <div id="live-clock-and-version" class="popup-clock">00:00 <span class="bot-version-display">${CONFIG.botVersion}</span></div>
                    </div>

                    <button class="popup-close-btn" title="بستن">${CONFIG.closeIconText}</button>
                </div>
            </div>
            <div class="popup-main-content">
                <section class="popup-section settings-section">
                    <button class="section-title collapsible-toggle" id="toggle-settings-btn">

                         ⚙️ تنظیمات و کنترل
                        <span class="collapse-icon"></span>
                    </button>
                    <div class="collapsible-content" id="settings-content">

                        <div class="main-settings-controls">
                            <button class="action-btn secondary-btn" id="toggle-mobile-panel-btn">
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" class="bi bi-phone-vibrate" viewBox="0 0 16 16"><path d="M10 3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1
1 0 0 1-1-1V4a1 1 0 0 1 1-1h4zM6 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H6z"/><path d="M8 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM1.586 6.414a.5.5 0 0 1 0 .708L.293 8.414a.5.5 0 0 1-.707-.707l1.293-1.293a.5.5 0 0 1 .707 0zm13.52.707a.5.5 0 0 1-.707 0l-1.293-1.293a.5.5 0 0 1 0-.708l1.293-1.293a.5.5 0 0 1 .707.707L15.106 7.12zM2 9.5a.5.5 0 0 1 .5-.5h.5a.5.5 0 0 1 0 1H2.5a.5.5 0 0 1-.5-.5zm12 0a.5.5 0 0 1 .5-.5h.5a.5.5 0 0 1 0 1h-.5a.5.5 0 0 1-.5-.5z"/></svg>

                               <span>شماره موبایل</span>
                            </button>
                            <button class="action-btn secondary-btn" id="check-update-btn">

                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="M8 2a5.53 5.53 0 0 0-3.594 1.342c-.766.66-1.321 1.52-1.464 2.383C1.266 6.095 0 7.555 0 9.318 0 11.366 1.708 13 3.781 13h8.906C14.502 13 16 11.57 16 9.773c0-1.636-1.242-2.969-2.834-3.194C12.923 3.999 10.69 2 8 2zm2.354 6.854-2 2a.5.5 0 0 1-.708 0l-2-2a.5.5 0 1 1 .708-.708L7.5 9.293V5.5a.5.5 0 0 1 1 0v3.793l1.146-1.147a.5.5 0 0 1 .708.708z"/></svg>

                                <span>${CONFIG.updateButtonText}</span>
                            </button>
                        </div>
                        <div class="settings-panel" id="mobile-input-panel" style="display: none;">

                            <label>شماره موبایل برای دریافت SMS را وارد کنید:</label>
                            <div class="settings-input-group">
                                 <input type="text" id="mobile-number-input" class="styled-input" value="${mobileNumber}" />

                                 <button class="action-btn secondary-btn" id="save-mobile-btn">${CONFIG.saveMobileButtonText}</button>
                            </div>
                        </div>

                        <div class="solver-options-panel">
                            <label class="panel-label">انتخاب حل‌کننده کپچا:</label>
                            <div class="settings-options" id="captcha-solver-settings">

                                <label><input type="radio" name="captcha-solver-option" value="solver-none"> غیرفعال</label>
                                <label><input type="radio" name="captcha-solver-option" value="solver-1"> عددی</label>
                                <label><input type="radio" name="captcha-solver-option" value="solver-2"> متنی</label>

                            </div>
                        </div>
                    </div>
                </section>
                <section class="popup-section initial-search-section">

                    <h3 class="section-title">۱. جستجوی خودرو</h3>
                    <div class="search-input-group">
                        <input type="text" id="model-search-input-popup" class="styled-input" placeholder="${CONFIG.popupSearchPlaceholder}" />
                        <button class="action-btn primary-btn" id="start-search-btn-popup">

                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0"/></svg>
                            <span>${CONFIG.startContinuousSearchText}</span>
                        </button>

                    </div>
                </section>
                <section class="popup-section search-results-section" style="display: none;">
                    <h3 class="section-title">۲. محصول پیدا شده</h3>
                    <div class="items-grid" id="search-items-grid-popup"></div>
                </section>
                <div class="captcha-sms-messages-container" style="display: none;">
                    <section class="popup-section captcha-sms-box">

                        <h3 class="section-title">۳. کپچا و کد SMS</h3>
                        <div class="captcha-image-container" id="captcha-image-display-popup"></div>
                        <input type="text" id="captcha-input-field-popup" class="styled-input captcha-input" placeholder="کد امنیتی (کپچا)" />
                        <div class="sms-input-group">

                            <input type="text" id="sms-input-field-popup" class="styled-input sms-input" placeholder="کد SMS" />
                            <button class="action-btn secondary-btn sms-btn" id="get-sms-code-btn-popup">${CONFIG.manualSmsButtonText}</button>
                        </div>

                        <button class="action-btn primary-btn submit-order-btn" id="submit-order-btn-popup" disabled>ثبت نهایی سفارش</button>
                    </section>
                    <section class="popup-section messages-box">
                        <h3 class="section-title">پیام‌های سیستم</h3>

                        <div class="messages-content" id="system-messages-content-popup"><p class="no-message-exist"></p></div>
                    </section>
                </div>
            </div>
        </div>`;
        document.body.appendChild(popup);
        uiElements = {
            mainPopup: popup,
            mainPopupContent: popup.querySelector('.popup-main-content'), // Reference to the scrollable content area
            initialSearchSection: popup.querySelector('.initial-search-section'),
            modelSearchInput: document.getElementById('model-search-input-popup'),
            startSearchButton: document.getElementById('start-search-btn-popup'),
            closeMainPopupButton: popup.querySelector('.popup-close-btn'),
            userDisplayName: document.getElementById('user-display-name'),
            liveClockAndVersion: document.getElementById('live-clock-and-version'),

            searchResultsSection: popup.querySelector('.search-results-section'),
            itemsGrid: document.getElementById('search-items-grid-popup'),
            captchaSmsContainer: popup.querySelector('.captcha-sms-messages-container'),
            systemMessagesContent: document.getElementById('system-messages-content-popup'),
            captchaImageDisplay: document.getElementById('captcha-image-display-popup'),
            captchaInput: document.getElementById('captcha-input-field-popup'),
            smsInput: document.getElementById('sms-input-field-popup'),
            getSmsCodeButton: document.getElementById('get-sms-code-btn-popup'),

            submitOrderButton: document.getElementById('submit-order-btn-popup'),
            noMessagePlaceholder: popup.querySelector('.no-message-exist'),
            toggleMobilePanelButton: document.getElementById('toggle-mobile-panel-btn'),
            mobileInputPanel: document.getElementById('mobile-input-panel'),
            mobileNumberInput: document.getElementById('mobile-number-input'),
            saveMobileButton: document.getElementById('save-mobile-btn'),
            updateButton: document.getElementById('check-update-btn'),

            toggleSettingsButton: document.getElementById('toggle-settings-btn'),
            settingsContent: document.getElementById('settings-content'),
        };
        uiElements.startSearchButton.addEventListener('click', toggleContinuousProductSearch);
        uiElements.getSmsCodeButton.addEventListener('click', handleManualSmsRequest);
        uiElements.submitOrderButton.addEventListener('click', handleSubmitOrder);
        uiElements.closeMainPopupButton.addEventListener('click', () => { uiElements.mainPopup.style.display = 'none'; resetPopupUI(); });
        uiElements.updateButton.addEventListener('click', handleUpdateCheck);
        window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && uiElements.mainPopup.style.display === 'flex') { uiElements.closeMainPopupButton.click(); } });
        uiElements.captchaInput.addEventListener('input', checkAndEnableSubmitButton);
        uiElements.smsInput.addEventListener('input', checkAndEnableSubmitButton);
        uiElements.toggleMobilePanelButton.addEventListener('click', () => {
            const panel = uiElements.mobileInputPanel;
            panel.style.display = (panel.style.display === 'none') ? 'block' : 'none';
        });
        uiElements.saveMobileButton.addEventListener('click', () => {
            const newNumber = uiElements.mobileNumberInput.value.trim();
            if (newNumber && /^[0-9]{11}$/.test(newNumber)) {
                mobileNumber = newNumber;
                GM_setValue('savedMobileNumber', mobileNumber);
                uiElements.userDisplayName.textContent = mobileNumber;

                displayMessage(`شماره موبایل به ${mobileNumber} تغییر یافت و ذخیره شد.`, 'success');
                uiElements.mobileInputPanel.style.display = 'none';
            } else {
                displayMessage('لطفاً یک شماره موبایل ۱۱ رقمی صحیح وارد کنید.', 'error');
            }
        });
        const solverRadios = popup.querySelectorAll('input[name="captcha-solver-option"]');
        solverRadios.forEach(radio => {
            if (radio.value === selectedSolver) radio.checked = true;
            radio.addEventListener('change', (e) => {
                selectedSolver = e.target.value;
                GM_setValue('selectedSolver', selectedSolver);
                const friendlyName = e.target.parentElement.textContent.trim();

                log('info', `تنظیمات حل‌کننده به: ${friendlyName} تغییر یافت.`);
                displayMessage(`حل‌کننده کپچا به ${friendlyName} تغییر یافت.`, 'success');
            });
        });
        uiElements.toggleSettingsButton.addEventListener('click', () => {
            const content = uiElements.settingsContent;
            const isOpen = content.style.display === 'block';
            content.style.display = isOpen ? 'none' : 'block';
            uiElements.toggleSettingsButton.classList.toggle('open', !isOpen);
        });
        resetPopupUI();
    }

    function checkAndEnableSubmitButton() {
        if(uiElements.captchaInput && uiElements.smsInput && uiElements.submitOrderButton) {
            uiElements.submitOrderButton.disabled = !(uiElements.captchaInput.value.trim() && uiElements.smsInput.value.trim());
        }
    }

    async function tryAutoSubmit() {
        if (currentOrderData.isSubmittingOrderProcess) return;
        if (currentOrderData.captchaAutoFilled && currentOrderData.smsAutoFilled) {
            log('info', 'کپچا و SMS خودکار پر شد. شبیه‌سازی کلیک برای ثبت نهایی...');
            const activeConfig = getActiveConfig();
            // --- تغییر اینجا: شبیه‌سازی کلیک روی دکمه ثبت نهایی ---
            // قبل از کلیک، مطمئن شوید دکمه فعال است
            if (!uiElements.submitOrderButton.disabled) {
                await simulateClick(uiElements.submitOrderButton, activeConfig.minClickDelayMs, activeConfig.maxClickDelayMs);
            } else {
                // اگر دکمه غیرفعال بود (مثلاً توسط یک اسکریپت دیگر یا مشکل در UI)،
                // مستقیماً تابع هندل کننده را فراخوانی کنید تا فرآیند ادامه یابد.
                log('warn', 'دکمه ثبت نهایی غیرفعال بود، مستقیماً تابع هندل کننده فراخوانی شد.');
                await handleSubmitOrder();
            }
            // --- پایان تغییر ---
        }
    }

    function displayMessage(text, type = 'info') {
        if(!uiElements.systemMessagesContent) return;
        const noMsg = uiElements.systemMessagesContent.querySelector('.no-message-exist');
        if(noMsg) noMsg.style.display = 'none';
        const md = document.createElement('div');
        md.className = `message ${type}`;
        md.innerHTML = `<span class="msg-text">${text}</span>`;
        uiElements.systemMessagesContent.prepend(md);
    }

    function updateClockDisplay() {
        if(!uiElements.liveClockAndVersion) return;
        const timeString = new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
        uiElements.liveClockAndVersion.innerHTML = `${timeString} <span class="bot-version-display">${CONFIG.botVersion}</span>`;
    }

    function displayFoundItem(project) {
        uiElements.itemsGrid.innerHTML = '';
        const card = document.createElement('div');
        card.className = 'found-product-card';
        const imageUrl = `https://esale.ikd.ir/images/${project.ModelCode}.jpg`;
        const placeholderUrl = `https://placehold.co/400x400/2b4157/f8f9fa?text=${encodeURIComponent(project.KhodroTitle)}`;
        card.innerHTML = `
            <div class="found-product-image">
                <img src="${imageUrl}" alt="تصویر ${project.KhodroTitle}" onerror="this.onerror=null;this.src='${placeholderUrl}';">
            </div>
            <div class="found-product-details">
                <h4 class="found-product-title">${project.KhodroTitle}</h4>
                <p class="found-product-model">${project.Title}</p>

                <div class="found-product-price">
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="currentColor" viewBox="0 0 16 16"><path d="M4 10.781c.525 1.657 2.343 3.219 5.088 3.219.525 0 1.023-.082 1.465-.223.442-.141.836-.324 1.178-.543.342-.219.633-.477.86-.77.227-.292.416-.612.558-.954.142-.342.24-.71.277-1.107.038-.396.058-.808.058-1.234s-.02-.838-.058-1.234a4.31 4.31 0 0 0-.277-1.107 4.312 4.312 0 0 0-.558-.954 4.322 4.322 0 0 0-.86-.77 4.328 4.328 0 0 0-1.178-.543A5.962 5.962 0 0 0 9.088 4c-2.746 0-4.563 1.562-5.088 3.219-.076.24-.117.487-.117.722s.04.481.117.722z"/><path d="M10.854 5.293a.5.5 0 0 0-.708-.707L7.543 6.22l-.646-.647a.5.5 0 1 0-.708.708l.647.646-.647.646a.5.5 0 1 0 .708.708l.646-.647.646.647a.5.5 0 0 0 .708-.707L8.25 7.28l2.604-2.605z M4.5 13.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0zm-1.5 0a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0zm1.5-1.5a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0zm-1.5 0a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0z"/></svg>
                    <span>قیمت:</span>
                    <span class="price-value">${project.InternetPrice?.toLocaleString('fa-IR') || 'N/A'} ریال</span>
                </div>
            </div>
        `;
        uiElements.itemsGrid.appendChild(card);
        uiElements.initialSearchSection.style.display = 'none';
        uiElements.searchResultsSection.style.display = 'block';
        uiElements.captchaSmsContainer.style.display = 'flex';

        // Scroll to the captcha/SMS container after displaying the product
        setTimeout(() => {
            if (uiElements.captchaSmsContainer && uiElements.mainPopupContent) {
                // Scroll the main content area to the captcha container
                uiElements.captchaSmsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 100);
    }

    function displayCaptcha(captchaData) {
        uiElements.captchaImageDisplay.innerHTML = '';
        if (captchaData.capchaData) {
            uiElements.captchaImageDisplay.innerHTML = captchaData.capchaData;
        } else if (captchaData.dataImage) {
            uiElements.captchaImageDisplay.innerHTML = `<img src="data:image/png;base64,${captchaData.dataImage}" alt="تصویر کپچا">`;
        }
    }

    // =====================================================================================
    // --- 🔄 MAIN APPLICATION LOGIC & CYCLES ---
    // =====================================================================================
    async function pollSmsFromRelay() {
        if (currentOrderData.stopProcess || !currentOrderData.selectedProject) return;
        const smsResult = await getLastSmsFromRelayServer();
        if (smsResult.success && smsResult.sms && !currentOrderData.smsAutoFilled) {
            log('success', `کد SMS از سرور واسط دریافت و جایگزاری شد: ${smsResult.sms}`);
            displayMessage(`کد SMS دریافت شد: ${smsResult.sms}`, 'success');
            currentOrderData.smsCode = smsResult.sms;
            currentOrderData.smsAutoFilled = true;
            // مقداردهی مستقیم برای SMS
            uiElements.smsInput.value = smsResult.sms;
            checkAndEnableSubmitButton();
            await tryAutoSubmit();
        }
    }

    function startSmsRelayPolling() {
        stopSmsRelayPolling();
        log('info', `شروع پایش مداوم SMS...`);
        const pollLoop = async () => {
            if (!currentOrderData.stopProcess) { // Check stopProcess here
                await pollSmsFromRelay();
                if (!currentOrderData.stopProcess) { // Re-check after poll
                    smsRelayPollingTimeoutId = setTimeout(pollLoop, CONFIG.smsRelayPollingIntervalMs);
                }
            } else {
                stopSmsRelayPolling(); // Stop if stopProcess is true
            }
        };
        pollLoop();
    }


    function stopSmsRelayPolling() {
        if (smsRelayPollingTimeoutId) {
            clearTimeout(smsRelayPollingTimeoutId);
            smsRelayPollingTimeoutId = null;
            log('info', 'پایش SMS متوقف شد.');
        }
    }

    async function startOrderProcess() {
        if (currentOrderData.stopProcess || !currentOrderData.selectedProject || currentOrderData.isSubmittingOrderProcess) return;
        const activeConfig = getActiveConfig();
        try {
            log('info', 'شروع فرآیند اصلی...');
            currentOrderData.captchaAutoFilled = false;
            currentOrderData.smsAutoFilled = false;
            if (uiElements.captchaInput) uiElements.captchaInput.value = '';
            if (uiElements.smsInput) uiElements.smsInput.value = '';
            checkAndEnableSubmitButton();
            await sleep(CONFIG.fixedDelays.apiDelayMs);
            displayMessage('در حال دریافت اطلاعات سفارش و کپچا...', 'info');

            const captchaApiResult = await getCaptchaOrderFromIKD(currentOrderData.selectedProject.IdDueDeliverProg, currentOrderData.captchaToken || "");
            if (!captchaApiResult.success) {
                displayMessage(`خطا در دریافت کپچا: ${captchaApiResult.error}. تلاش مجدد...`, 'error');
                setTimeout(startOrderProcess, CONFIG.fixedDelays.retryDelayMs);
                return;
            }

            if (!currentOrderData.orderDetails) {
                await sleep(getRandomDelay(200, 500));
                const orderDetailsResult = await getOrderDetailsFromIKD(currentOrderData.selectedProject);
                if (!orderDetailsResult.success) {
                    displayMessage(`خطا در دریافت اطلاعات سفارش: ${orderDetailsResult.error}. تلاش مجدد...`, 'error');
                    return;
                }
                currentOrderData.orderDetails = orderDetailsResult.data;
            }
            log('success', 'اطلاعات اولیه سفارش با موفقیت دریافت شد.');
            if (!currentOrderData.initialSmsRequestSent) {
                log('info', 'ارسال اولین درخواست SMS به سرور ایران‌خودرو...');
                const smsResponse = await requestSmsFromIKD();
                if (smsResponse.success) {
                    displayMessage('درخواست اولیه SMS با موفقیت ارسال شد.', 'success');
                    currentOrderData.initialSmsRequestSent = true;
                    if (!uiElements.getSmsCodeButton.disabled) startManualSmsCooldownTimer();
                } else {
                    displayMessage(`ارسال درخواست اولیه SMS ناموفق: ${smsResponse.error}`, 'error');
                    if (smsResponse.isCooldown) startManualSmsCooldownTimer(Math.ceil(smsResponse.timeLeftMs / 1000));
                }
            }

            displayCaptcha(captchaApiResult.data);
            currentOrderData.captchaToken = captchaApiResult.data.token;
            if (selectedSolver !== 'solver-none') {
                for (let i = 0; i < activeConfig.maxCaptchaSolveRetries; i++) {
                    displayMessage(`تلاش ${i + 1} از ${activeConfig.maxCaptchaSolveRetries} برای حل خودکار کپچا...`, 'info');
                    const solveResponse = await solveCaptcha(captchaApiResult.data);
                    if (solveResponse.success && solveResponse.answer) {
                        displayMessage('کپچای جدید به طور خودکار حل شد.', 'success');
                        currentOrderData.captchaCode = solveResponse.answer;
                        currentOrderData.captchaAutoFilled = true;
                        // --- تغییر اینجا: کلیک شبیه‌سازی شده قبل از تایپ کپچا ---
                        log('info', 'شبیه‌سازی کلیک روی باکس ورودی کپچا...');
                        await simulateClick(uiElements.captchaInput, activeConfig.minClickDelayMs, activeConfig.maxClickDelayMs);
                        // --- پایان تغییر ---
                        await simulateTyping(uiElements.captchaInput, solveResponse.answer, activeConfig.minCaptchaTypingDelayMs, activeConfig.maxCaptchaTypingDelayMs);
                        await tryAutoSubmit();
                        break;
                    }
                    displayMessage(`تلاش ${i + 1} برای حل خودکار کپچا ناموفق بود: ${solveResponse.error || ''}.`, 'warn');
                    if (i < activeConfig.maxCaptchaSolveRetries - 1) await sleep(getRandomDelay(activeConfig.minCaptchaRetryDelayMs, activeConfig.maxCaptchaRetryDelayMs));
                }
                if (!currentOrderData.captchaAutoFilled) displayMessage('حل خودکار کپچا پس از چند تلاش ناموفق بود. لطفاً دستی وارد کنید.', 'warn');
            } else {
                displayMessage('حل خودکار کپچا غیرفعال است. لطفاً دستی وارد کنید.', 'warn');
                log('info', 'حل‌کننده خودکار غیرفعال است. شبیه‌سازی کلیک روی باکس کپچا برای ورود دستی.');
                // کلیک خودکار روی کادر کپچا
                if (uiElements.captchaInput) {
                    uiElements.captchaInput.focus();
                }
            }
            checkAndEnableSubmitButton();
        } catch (e) {
            log('error', 'یک خطای پیش‌بینی نشده در فرآیند اصلی رخ داد. ربات مجددا تلاش خواهد کرد.', e);
            displayMessage(`یک خطای غیرمنتظره رخ داد: ${e.message}. شروع مجدد...`, 'error');
            setTimeout(startOrderProcess, getRandomDelay(getActiveConfig().minRetryDelayMs, getActiveConfig().maxRetryDelayMs));
        }
    }

    function stopMainProcess() {
        currentOrderData.stopProcess = true;
        stopSmsRelayPolling();
        if (mainProcessTimeoutId) clearTimeout(mainProcessTimeoutId);
    }

    async function performContinuousProductSearchStep(searchTerm) {
        if (!isContinuousSearchingProduct) return;
        try {
            const projectsResponse = await getSaleProjectsFromIKD();
            if (!isContinuousSearchingProduct) return;
            if (projectsResponse.success && projectsResponse.data?.saleProjects?.length > 0) {
                const foundProject = findClosestMatch(searchTerm, projectsResponse.data.saleProjects);
                if (foundProject) {
                    log('success', `محصول "${foundProject.KhodroTitle}" با الگوریتم ترکیبی پیدا شد!`);
                    stopContinuousProductSearch();
                    currentOrderData.selectedProject = foundProject;
                    displayMessage(`محصول "${foundProject.KhodroTitle}" پیدا و انتخاب شد.`, 'success');
                    displayFoundItem(foundProject);
                    currentOrderData.stopProcess = false;
                    startSmsRelayPolling();
                    startOrderProcess();
                } else {
                    displayMessage(`محصول "${searchTerm}" هنوز یافت نشد.`, 'info');
                }
            } else {
                displayMessage(projectsResponse.error ? `خطا در دریافت لیست محصولات: ${projectsResponse.error}.` : `لیست محصولات خالی است.`, 'warn');
            }
        } catch (e) {
            log('error', 'خطا در حلقه جستجوی محصول.', e);
        }
    }

    function startContinuousProductSearch() {
        const st = uiElements.modelSearchInput.value.trim();
        if(!st) { displayMessage('مدل را وارد کنید.','warn'); return; }
        if(isContinuousSearchingProduct) return;
        isContinuousSearchingProduct = true;
        uiElements.startSearchButton.textContent = CONFIG.stopContinuousSearchText;
        uiElements.modelSearchInput.disabled = true;
        displayMessage(`جستجوی مستمر برای "${st}" آغاز شد...`,'info');
        const searchLoop = async () => {
            if (!isContinuousSearchingProduct) return;
            await performContinuousProductSearchStep(st);
            if (isContinuousSearchingProduct) {
                productSearchPollingTimeoutId = setTimeout(searchLoop, CONFIG.searchPollingIntervalMs);
            }
        };
        searchLoop();
    }

    function stopContinuousProductSearch() {
        if(productSearchPollingTimeoutId) { clearTimeout(productSearchPollingTimeoutId); productSearchPollingTimeoutId = null; }
        isContinuousSearchingProduct = false;
        if(uiElements.startSearchButton) { uiElements.startSearchButton.textContent = CONFIG.startContinuousSearchText; uiElements.startSearchButton.disabled = false; }
        if(uiElements.modelSearchInput) uiElements.modelSearchInput.disabled = false;
        log('info','جستجوی محصول متوقف شد.');
    }

    function toggleContinuousProductSearch() {
        isContinuousSearchingProduct ? stopContinuousProductSearch() : startContinuousProductSearch();
    }

    function startManualSmsCooldownTimer(totalSeconds = CONFIG.smsCooldownMinutes * 60) {
        let timeLeft = totalSeconds;
        if (smsCooldownInterval) clearInterval(smsCooldownInterval);
        const updateTimer = () => {
            if (timeLeft <= 0) {
                clearInterval(smsCooldownInterval);
                if (uiElements.getSmsCodeButton) {
                    uiElements.getSmsCodeButton.textContent = CONFIG.manualSmsButtonText;
                    uiElements.getSmsCodeButton.disabled = false;
                }
            } else {
                const minutes = Math.floor(timeLeft / 60);
                const seconds = timeLeft % 60;
                if (uiElements.getSmsCodeButton) {
                    uiElements.getSmsCodeButton.textContent = CONFIG.manualSmsCooldownText.replace('{timeLeft}', `${minutes}:${seconds.toString().padStart(2, '0')}`);
                    uiElements.getSmsCodeButton.disabled = true;
                }
                timeLeft--;
            }
        };
        updateTimer();
        smsCooldownInterval = setInterval(updateTimer, 1000);
    }

    function checkSmsCooldownOnLoad() {
        if (smsCooldownInterval) clearInterval(smsCooldownInterval);
        const lastSmsTime = parseInt(localStorage.getItem(CONFIG.smsTimestampKey) || '0');
        const timePassed = Date.now() - lastSmsTime;
        const cooldownMs = CONFIG.smsCooldownMinutes * 60 * 1000;
        if (timePassed < cooldownMs) {
            startManualSmsCooldownTimer(Math.ceil((cooldownMs - timePassed) / 1000));
        }
    }

    async function handleManualSmsRequest() {
        if(!currentOrderData.selectedProject){ displayMessage('ابتدا محصول باید انتخاب شود.','warn');
        return; }
        if (uiElements.getSmsCodeButton.disabled) { displayMessage('لطفاً تا پایان شمارش معکوس صبر کنید.','warn'); return;
        }
        displayMessage(`در حال ارسال درخواست SMS به ایران‌خودرو...`, 'info');
        uiElements.getSmsCodeButton.disabled = true;
        const smsResponse = await requestSmsFromIKD();
        if (!smsResponse.success) {
            displayMessage(`ارسال درخواست SMS به ایران‌خودرو ناموفق: ${smsResponse.error}.`, 'error');
        } else {
            displayMessage('درخواست SMS با موفقیت به ایران‌خودرو ارسال شد.', 'success');
        }
        startManualSmsCooldownTimer();
    }

    async function handleSubmitOrder() {
        if (currentOrderData.isSubmittingOrderProcess) return;
        currentOrderData.isSubmittingOrderProcess = true;
        stopMainProcess(); // Stop polling during submission attempt
        if (uiElements.submitOrderButton) {
            uiElements.submitOrderButton.disabled = true;
            uiElements.submitOrderButton.textContent = `در حال ثبت...`;
        }
        const captchaCode = uiElements.captchaInput.value.trim();
        const smsCode = uiElements.smsInput.value.trim();
        if (!captchaCode || !smsCode) {
            displayMessage('کپچا و کد SMS هر دو باید پر شوند.', 'error');
            currentOrderData.isSubmittingOrderProcess = false;
            checkAndEnableSubmitButton();
            return;
        }
        currentOrderData.captchaCode = captchaCode;
        currentOrderData.smsCode = smsCode;
        if (!currentOrderData.selectedProject || !currentOrderData.captchaToken || !currentOrderData.orderDetails) {
            displayMessage('اطلاعات سفارش ناقص است. فرآیند ریست می‌شود.', 'error');
            resetPopupUI();
            currentOrderData.isSubmittingOrderProcess = false;
            return;
        }

        const finalOrderDetails = currentOrderData.orderDetails;
        const orderPayload = { agencyShow: 2,
                              idDueDeliverProg: parseInt(currentOrderData.selectedProject.IdDueDeliverProg),
                              agency: finalOrderDetails.agency,
                              idBaseColor: parseInt(finalOrderDetails.selectedColor),

                              idBaseUsage: parseInt(finalOrderDetails.selectedUsage),
                              smsKey: currentOrderData.smsCode,
                              quantity: 1,

                              responDoc: true,
                              idBank: 23,
                              valueId: generateUUID(),

                              captchaText: currentOrderData.captchaCode,
                              captchaToken: currentOrderData.captchaToken,
                              agencyId: parseInt(finalOrderDetails.agencyId), };
        const addOrderResponse = await addOrderToIKD(orderPayload);

        if (addOrderResponse.success) {
            displayMessage('سفارش با موفقیت ثبت و به بانک هدایت می‌شوید.', 'success');
            // Do not call stopMainProcess again, it's already stopped. It will fully stop on redirect.
        } else {
            displayMessage(`ثبت نهایی ناموفق: ${addOrderResponse.error}.`, 'error');
            log('error', 'ثبت نهایی ناموفق بود. پاسخ سرور:', addOrderResponse);
            log('warn', `کپچای ارسال شده: ${captchaCode}, کد پیامک ارسال شده: ${smsCode}. فرآیند مجدداً آغاز می‌شود.`);
            const delay = getRandomDelay(getActiveConfig().minSubmitFailedDelayMs, getActiveConfig().maxSubmitFailedDelayMs);
            displayMessage(`فرآیند تا ${delay / 1000} ثانیه دیگر به صورت خودکار مجدداً آغاز می‌شود...`, 'info');
            currentOrderData.isSubmittingOrderProcess = false;
            currentOrderData.stopProcess = false;
            setTimeout(() => {
                startSmsRelayPolling(); // Restart polling for the next attempt
                startOrderProcess();
            }, delay);
        }
    }

    async function handleUpdateCheck() {
        const SCRIPT_URL = 'https://github.com/masoudes72/ikd/raw/refs/heads/main/ikddd.user.js';
        displayMessage('درحال باز کردن صفحه نصب/به‌روزرسانی...', 'info');
        window.open(SCRIPT_URL, '_blank');
    }

    // =====================================================================================
    // --- 🚀 SCRIPT INITIALIZATION & ENTRY POINT ---
    // =====================================================================================
    function ensureUIExists() {
        if (!document.getElementById('ikd-bot-trigger-btn')) createTriggerButton();
        if (!document.getElementById('ikd-main-process-popup')) createMainPopupUI();
    }

    function initializeScript() {
        log('info', `Script initializing (${CONFIG.botVersion}).`);
        selectedSolver = GM_getValue('selectedSolver', 'solver-2');
        mobileNumber = GM_getValue('savedMobileNumber', CONFIG.defaultMobileNumber);
        authToken = localStorage.getItem(CONFIG.localStorageTokenKey);
        if (!authToken) {
            const msg = `توکن لاگین یافت نشد.
لطفاً ابتدا در سایت https://esale.ikd.ir لاگین کنید و سپس صفحه را رفرش نمایید.`;
            // Do not use alert(), use a custom modal for user experience. For now, we log the error.
            console.error(msg);
            // Example of a simple inline message instead of alert:
            const errorDiv = document.createElement('div');
            errorDiv.style.cssText = `
                position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                background-color: #f44; color: white; padding: 20px; border-radius: 8px;
                z-index: 10000; text-align: center; font-family: 'IRANSans', Tahoma, sans-serif;
                box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            `;
            errorDiv.innerHTML = `<p>${msg.replace(/\n/g, '<br>')}</p><button onclick="this.parentNode.remove()" style="background: none; border: 1px solid white; color: white; padding: 5px 10px; border-radius: 4px; cursor: pointer; margin-top: 10px;">بستن</button>`;
            document.body.appendChild(errorDiv);
            return;
        }
        applyStyles();
        createMainPopupUI();
        createTriggerButton();
        updateClockDisplay();
        setInterval(updateClockDisplay, 1000 * 30);
        setInterval(ensureUIExists, 2000);
        log('info', 'اسکریپت مقداردهی اولیه شد و UI در حال پایش است.');
    }

    function applyStyles() {
        GM_addStyle(`
            :root{
                --theme-primary:#f4a261; /* Vibrant Orange for accents */
                --theme-secondary:#2b4157; /* Dark Gray/Blue Base */
                --lighter-shade:#37506b; /* Slightly lighter shade for neumorphism highlights */
                --darker-shade:#21324a; /* Slightly darker shade for neumorphism shadows */
                --theme-dark-gray:#212529;
                --theme-light-gray:#e0e0e0;
                --theme-text-light:#f8f9fa;
                --theme-text-dark:#212529;
                --success-bg:rgba(40,200,130,.1);--success-text:rgba(200,255,220,.9);--success-border: #2c8;
                --error-bg:rgba(255,60,60,.1);--error-text:rgba(255,200,200,.9);--error-border:#f44;
                --warn-bg:rgba(255,170,0,.1);--warn-text:rgba(255,220,180,.9);--warn-border:#fa0;
                --font-family:'IRANSans','Tahoma',sans-serif;
                --border-radius-sm:8px; /* Slightly more rounded */
                --border-radius-md:12px; /* More rounded for neumorphism */
                --box-shadow:0 .5rem 1rem rgba(0,0,0,.15);
                --neumorphic-shadow-out: 6px 6px 12px var(--darker-shade), -6px -6px 12px var(--lighter-shade);
                --neumorphic-shadow-in: inset 6px 6px 12px var(--darker-shade), inset -6px -6px 12px var(--lighter-shade);
                --neumorphic-shadow-hover-out: 3px 3px 6px var(--darker-shade), -3px -3px 6px var(--lighter-shade);
                --neumorphic-shadow-hover-in: inset 3px 3px 6px var(--darker-shade), inset -3px -3px 6px var(--lighter-shade);
            }
            body{font-family:var(--font-family)}
            @keyframes pulsing-glow {
                0% { box-shadow: 0 0 5px var(--theme-primary), 0 0 10px var(--theme-primary); }
                50% { box-shadow: 0 0 20px var(--theme-primary), 0 0 30px var(--theme-primary); }
                100% { box-shadow: 0 0 5px var(--theme-primary), 0 0 10px var(--theme-primary); }
            }
            #ikd-bot-trigger-btn {
                position: fixed;
                bottom: 25px; right: 25px; padding: 12px 20px;
                background-color: var(--theme-secondary); /* Base color for neumorphism */
                color: var(--theme-text-light);
                border: none;
                border-radius: 50px;
                box-shadow: var(--neumorphic-shadow-out); /* Neumorphic convex shadow */
                font-size: 16px; font-weight: 500; cursor: pointer; z-index: 9999;
                display: flex; align-items: center; justify-content: center;
                gap: 10px;
                transition: all .3s ease-in-out; /* Smooth transition for neumorphism */
                animation: none; /* Remove initial pulsing glow, can add subtle one on hover */
            }
            #ikd-bot-trigger-btn:hover {
                transform: translateY(0); /* Remove the lift from original design */
                box-shadow: var(--neumorphic-shadow-hover-in); /* Simulate pressed in effect */
            }
            #ikd-bot-trigger-btn svg { transition: transform .3s ease;
            }
            #ikd-bot-trigger-btn:hover svg { transform: rotate(15deg);
            }
            .popup{position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,.7);display:none;justify-content:center;align-items:center;z-index:10001;padding:20px;backdrop-filter:blur(3px);direction:rtl}
            .popup-content-wrapper{
                background-color:var(--theme-secondary);
                color:var(--theme-text-light);
                border-radius:var(--border-radius-md);
                width:100%;max-width:900px;max-height:95vh;
                box-shadow: 10px 10px 20px rgba(0,0,0,0.4), -10px -10px 20px rgba(255,255,255,0.05); /* Soft outer shadow for the main popup */
                display:flex;flex-direction:column;overflow:hidden;
                border: none; /* Remove original border */
            }
            .popup-header{background:none; /* Remove original gradient */
            background-color: var(--theme-secondary); /* Use base color */
            padding:1rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.05); /* Softer divider */
            flex-wrap: wrap;}
            .popup-header-left { display: flex;
            align-items: center; gap: 15px; }
            .popup-header-right { display: flex;
            align-items: center; gap: 20px; flex-wrap: wrap; }
            .popup-logo{height:40px;filter: drop-shadow(0 0 5px rgba(244,162,97,0.5));}
            .popup-title { font-size: 1.25rem;
            font-weight: 500; margin: 0; color: #fff; }
            .header-info-item { display: flex;
            align-items: center; gap: 8px; font-size: 0.85rem; color: var(--theme-light-gray); }
            .header-info-item svg { color: var(--theme-primary);
            }
            #live-clock-and-version { direction: ltr; font-family: monospace;
            }
            .bot-version-display { font-size: 0.75rem; color: rgba(255,255,255,0.6); margin-left: 8px;
            }
            .popup-close-btn{background:transparent;border:none;color:var(--theme-light-gray);font-size:28px;font-weight:700;cursor:pointer;padding:0 8px;line-height:1;transition:color .2s ease, transform .2s ease;}
            .popup-close-btn:hover{color:var(--theme-primary);
            transform: rotate(90deg);}
            .popup-main-content{padding:1.5rem;display:flex;flex-direction:column;gap:1.5rem;overflow-y:auto;flex-grow:1}
            .popup-section{
                background-color:var(--theme-secondary); /* Same as base for seamless look */
                padding:1.25rem;
                border-radius:var(--border-radius-md);
                box-shadow: var(--neumorphic-shadow-in); /* Inset effect for sections */
                border: none; /* Remove original border */
                transition: all .3s ease-in-out;
            }
            .section-title{margin:0 0 1rem;color:var(--theme-primary);border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:10px;font-size:1.1rem;font-weight:500;}
            .search-input-group {
                display: flex;
                gap: 10px;
                justify-content: center; /* Center the items horizontally */
            }
            .settings-input-group {
                display: flex;
                gap: 10px;
            }
            .styled-input{
                width:100%;padding:12px 15px;margin:0;
                border:none; /* Remove original border */
                border-radius:var(--border-radius-sm);
                font-size:1rem;
                background-color:var(--theme-secondary); /* Base color */
                color:var(--theme-text-light);
                box-shadow: var(--neumorphic-shadow-in); /* Inset shadow for inputs */
                transition:all .2s ease-in-out;
            }
            .styled-input::placeholder{color:rgba(255,255,255,.4)}
            .styled-input:focus{
                outline:0;
                border-color:transparent; /* No border on focus */
                box-shadow: inset 4px 4px 8px var(--darker-shade), inset -4px -4px 8px var(--lighter-shade), 0 0 0 3px var(--theme-primary); /* Inset with accent glow */
            }
            .action-btn{padding:12px 18px;font-size:1rem;font-weight:500;border-radius:var(--border-radius-sm);cursor:pointer;border:none;transition:all .3s ease-in-out;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;}
            .action-btn.primary-btn{
                background-color: var(--theme-primary); /* Solid accent color */
                color:white;
                box-shadow: 4px 4px 8px rgba(0,0,0,0.3), -4px -4px 8px rgba(255,255,255,0.1); /* Soft convex shadow */
            }
            .action-btn.primary-btn:hover{
                transform: translateY(0); /* Remove original lift */
                box-shadow: inset 2px 2px 5px rgba(0,0,0,0.3), inset -2px -2px 5px rgba(255,255,255,0.1); /* Pressed effect */
            }
            .action-btn.secondary-btn {
                background-color: var(--theme-secondary); /* Base color */
                color: var(--theme-text-light);
                box-shadow: var(--neumorphic-shadow-out); /* Convex shadow for secondary buttons */
            }
            .action-btn.secondary-btn:hover {
                background-color: var(--theme-secondary); /* Keep base color */
                box-shadow: var(--neumorphic-shadow-hover-in); /* Pressed effect */
            }
            .action-btn:disabled{
                background-color: var(--darker-shade) !important; /* Slightly darker when disabled */
                color:#868e96!important;
                cursor:not-allowed;
                transform:none;
                box-shadow: inset 2px 2px 5px var(--darker-shade); /* subtle inset */
            }
            .items-grid .found-product-card {
                background-color: var(--theme-secondary); /* Base color */
                border-radius: var(--border-radius-md);
                border: none; /* Remove original border */
                box-shadow: var(--neumorphic-shadow-out); /* Convex shadow for product cards */
                display: flex; align-items: center; gap: 20px; padding: 1rem; overflow: hidden;
                transition: all .3s ease-in-out;
            }
            .items-grid .found-product-card:hover {
                box-shadow: var(--neumorphic-shadow-hover-out); /* Slightly smaller convex shadow on hover */
            }
            .found-product-image {
                width: 120px; height: 120px; flex-shrink: 0;
                border-radius: var(--border-radius-sm); overflow: hidden;
                box-shadow: inset 2px 2px 5px var(--darker-shade), inset -2px -2px 5px var(--lighter-shade); /* Subtle inset for image container */
            }
            .found-product-image img { width: 100%;
            height: 100%; object-fit: cover; transition: transform .3s ease; }
            .found-product-card:hover .found-product-image img { transform: scale(1.05); /* Slight zoom */
            }
            .found-product-details { display: flex; flex-direction: column; gap: 0.5rem;
            flex-grow: 1; }
            .found-product-title { font-size: 1.2rem; font-weight: 500;
            color: var(--theme-primary); margin: 0; }
            .found-product-model { font-size: .9rem;
            color: var(--theme-light-gray); margin: 0; line-height: 1.5; }
            .found-product-price { display: flex;
            align-items: center; gap: 8px; background-color: var(--darker-shade); /* Darker shade for price background */
            padding: .5rem 1rem; border-radius: var(--border-radius-sm); font-size: 1rem; font-weight: 500; margin-top: 0.5rem; align-self: flex-start;
            box-shadow: inset 2px 2px 4px rgba(0,0,0,0.2); /* Small inset shadow */
            }
            .found-product-price .price-value { color: var(--theme-primary); font-weight: bold;
            }
            .found-product-price svg { color: var(--theme-primary);
            }
            /* Main container for captcha and messages - default to row for larger screens */
            .captcha-sms-messages-container {
                display: flex;
                flex-direction: row; /* Default to row for desktop */
                gap: 20px;
                align-items: flex-start;
            }
            /* Flex ratios for captcha and messages boxes on wider screens */
            .captcha-sms-box{flex:1.2;}
            .messages-box{flex:.8;}

            .captcha-sms-box,.messages-box{min-width:0}
            .messages-content{max-height:280px;overflow-y:auto;padding-right:10px;scrollbar-width:thin;scrollbar-color:var(--theme-primary) rgba(255,255,255,.1)}
            .messages-content::-webkit-scrollbar{width:8px}
            .messages-content::-webkit-scrollbar-track{background:rgba(255,255,255,.05)}
            .messages-content::-webkit-scrollbar-thumb{background-color:var(--theme-primary);border-radius:4px}
            .message{padding:10px 12px;margin-bottom:8px;border-radius:var(--border-radius-sm);font-size:13px;display:flex;align-items:center;gap:10px;line-height:1.5;
            background-color: var(--theme-secondary); /* Use base color for messages */
            color: rgba(200,220,255,.9);
            border-left: 4px solid #39f; /* Keep the color indicator */
            box-shadow: inset 2px 2px 5px var(--darker-shade); /* Subtle inset for messages */
            }
            .message.success{background-color: var(--theme-secondary); color:rgba(200,255,220,.9);border-left-color:#2c8;}
            .message.error{background-color: var(--theme-secondary); color:rgba(255,255,200,.9);border-left-color:#f44;} /* Fixed color for error message */
            .message.warn{background-color: var(--theme-secondary); color:rgba(255,220,180,.9);border-left-color:#fa0;}
            .msg-text{flex-grow:1}
            .no-message-exist{color:rgba(255,255,255,.5);text-align:center;padding:15px 0;font-style:italic}
            .captcha-image-container{
                text-align:center;margin-bottom:15px;
                background-color: var(--lighter-shade); /* Lighter shade for contrast inside inset */
                padding:10px;border-radius:var(--border-radius-sm);
                box-shadow: inset 3px 3px 6px var(--darker-shade), inset -3px -3px 6px var(--lighter-shade); /* Inset for captcha image */
                border: none;
                min-height:60px;display:flex;justify-content:center;align-items:center
            }
            .captcha-image-container img,.captcha-image-container svg{max-width:230px;height:auto;display:inline-block}

            .sms-input-group{display:flex;gap:10px;align-items:center;margin-bottom:15px}
            .sms-input-group .styled-input{margin-bottom:0;flex-grow:1;
            width: auto;}
            .sms-btn{padding:12px 15px;flex-shrink:0;
            width: auto;}
            .submit-order-btn{margin-top:10px; font-size: 1.1rem;
            padding: 15px;}
            .settings-section {
                background-color: var(--theme-secondary); /* Same as base */
                box-shadow: var(--neumorphic-shadow-in); /* Inset shadow */
            }
            .main-settings-controls { display: flex; gap: 10px;
            }
            .main-settings-controls .action-btn { flex-grow: 1;
            }
            .settings-panel {
                background-color: var(--darker-shade); /* Slightly darker for the panel background */
                padding: 1rem; border-radius: var(--border-radius-sm);
                margin-top: 1rem;
                box-shadow: inset 3px 3px 6px rgba(0,0,0,0.3), inset -3px -3px 6px rgba(255,255,255,0.05); /* Deeper inset */
                border: none;
            }
            .settings-panel label { display: block;
            margin-bottom: 0.5rem; font-size: 0.9rem; color: var(--theme-light-gray); }
            .solver-options-panel { margin-top: 1rem;
            padding: 1rem;
            background-color: var(--darker-shade); /* Slightly darker for the panel background */
            border-radius: var(--border-radius-sm);
            box-shadow: inset 3px 3px 6px rgba(0,0,0,0.3), inset -3px -3px 6px rgba(255,255,255,0.05); /* Deeper inset */
            border: none;
            }
            .panel-label { display: block; margin-bottom: 0.75rem; font-size: 0.9rem;
            font-weight: 500; color: var(--theme-light-gray); }
            .settings-options { display: flex;
            justify-content: space-around; flex-wrap: wrap; gap: 10px;}
            .settings-options label { display: flex;
            align-items: center; gap: 8px; cursor: pointer; color: var(--theme-light-gray); font-size: 0.9rem;
            }
            .settings-options input[type="radio"] { accent-color: var(--theme-primary);
            }
            .collapsible-toggle { display: none; /* Hide by default in desktop */
            }
            @media (max-width: 991px) {
                .popup-content-wrapper { max-width: calc(100% - 20px);
                max-height: 98vh; margin: 10px; }
                .popup-header{ flex-direction: column;
                align-items: flex-start; gap: 10px; padding: 10px 15px; }
                .popup-header-right { flex-direction: column;
                align-items: flex-start; width: 100%; gap: 8px; }
                .popup-title { font-size: 1.1rem;
                }
                .popup-main-content{ padding: 15px;
                gap: 15px; }
                .popup-section{ padding: 15px;
                }
                .search-input-group, .settings-input-group, .sms-input-group { flex-direction: column;
                }
                .items-grid .found-product-card { flex-direction: column;
                align-items: center; text-align: center; }
                .found-product-image { width: 100%;
                height: 180px; }
                .found-product-price { align-self: center;
                }
                /* For mobile, stack captcha and messages vertically */
                .captcha-sms-messages-container{ flex-direction: column; }

                .collapsible-toggle { display: flex; /* Show on mobile */
                width: 100%; justify-content: space-between; align-items: center; background: none; border: none; cursor: pointer; padding: 10px 0; color: var(--theme-primary); font-size: 1.1rem;
                font-weight: 500; border-bottom: 1px solid rgba(255,255,255,.15); margin-bottom: 1rem; text-align: right;
                }
                .collapsible-toggle .collapse-icon { display: inline-block;
                width: 0; height: 0; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 5px solid var(--theme-primary); transition: transform 0.3s ease;
                margin-right: 8px; }
                .collapsible-toggle.open .collapse-icon { transform: rotate(180deg);
                }
                .collapsible-content { display: none; /* Collapsed by default on mobile */
                }
            }
        `);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeScript);
    } else {
        initializeScript();
    }

})();
