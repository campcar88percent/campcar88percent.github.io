// ======================================================
// 88CAMPCAR — script.js
// 予約フォーム・お問い合わせ・予約済み日程: サーバーAPI
// ======================================================

// --- 1. ナビゲーションのスクロール制御 ---
const navbar = document.getElementById('navbar');
const navLogo = document.getElementById('nav-logo');
const navLinks = document.getElementById('nav-links');

window.addEventListener('scroll', () => {
    if (window.scrollY > 80) {
        navbar.classList.add('scrolled', 'bg-white', 'shadow-md', 'py-4', 'border-black/5');
        navbar.classList.remove('bg-transparent', 'py-8', 'border-transparent');
        navLogo.classList.add('text-black');
        navLogo.classList.remove('text-white');
        if (navLinks) {
            navLinks.classList.add('text-black/70');
            navLinks.classList.remove('text-white/80');
        }
    } else {
        navbar.classList.remove('scrolled', 'bg-white', 'shadow-md', 'py-4', 'border-black/5');
        navbar.classList.add('bg-transparent', 'py-8', 'border-transparent');
        navLogo.classList.add('text-white');
        navLogo.classList.remove('text-black');
        if (navLinks) {
            navLinks.classList.add('text-white/80');
            navLinks.classList.remove('text-black/70');
        }
    }
}, { passive: true });

// --- 2. 予約カレンダー ---
const calendarEl = document.getElementById('calendar');
const calMonthLabel = document.getElementById('cal-month-label');
const calPrev = document.getElementById('cal-prev');
const calNext = document.getElementById('cal-next');
const calDots = document.getElementById('cal-dots');

let calBookedSet = new Set();
let calCurrentMonth = new Date();
calCurrentMonth.setDate(1);

let calSelStart = null;
let calSelEnd = null;

const MONTH_NAMES = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const WEEK_HEADS = ['月','火','水','木','金','土','日'];

// 予約済み日付をサーバーAPIから取得
async function fetchBookedDates() {
    try {
        const res = await fetch('/api/reservations/dates?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('予約日取得に失敗');
        const data = await res.json();
        calBookedSet = new Set(data.booked || []);
    } catch (e) {
        console.warn('予約済み日程の取得に失敗しました。', e);
        calBookedSet = new Set();
    }
}

function parseDate(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }

function daysBetween(a, b) {
    const d1 = parseDate(a), d2 = parseDate(b);
    return Math.round((d2 - d1) / 86400000) + 1;
}

function datesInRange(startStr, endStr) {
    const dates = [];
    const d = parseDate(startStr);
    const end = parseDate(endStr);
    while (d < end) {
        dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
        d.setDate(d.getDate() + 1);
    }
    return dates;
}

function hasBookedInRange(startStr, endStr) {
    return datesInRange(startStr, endStr).some(d => calBookedSet.has(d));
}

function determinePlan(startStr, endStr) {
    const nights = daysBetween(startStr, endStr) - 1;
    if (nights >= 7) return { plan: 'weekly', name: 'ウィークリープラン', pricePerDay: 19000, nights };
    if (nights >= 4) return { plan: 'medium', name: 'ミディアムプラン', pricePerDay: 22000, nights };
    return { plan: 'short', name: 'ショートステイ', pricePerDay: 26000, nights };
}

function formatDateJP(str) {
    const d = parseDate(str);
    return `${d.getMonth()+1}月${d.getDate()}日`;
}

function updateSelectionUI() {
    const guideEl = document.getElementById('cal-selection-guide');
    const rangeEl = document.getElementById('cal-selected-range');
    const startLabel = document.getElementById('cal-start-label');
    const endLabel = document.getElementById('cal-end-label');
    const planBadge = document.getElementById('cal-plan-badge');
    const confirmArea = document.getElementById('cal-confirm-area');
    const planSummary = document.getElementById('cal-plan-summary');

    if (!calSelStart) {
        if (guideEl) { guideEl.classList.remove('hidden'); guideEl.querySelector('p').textContent = '開始日をタップしてください'; }
        if (rangeEl) rangeEl.classList.add('hidden');
        if (confirmArea) confirmArea.classList.add('hidden');
        return;
    }
    if (calSelStart && !calSelEnd) {
        if (guideEl) { guideEl.classList.remove('hidden'); guideEl.querySelector('p').textContent = '終了日をタップしてください'; }
        if (rangeEl) { rangeEl.classList.remove('hidden'); rangeEl.classList.add('flex'); }
        if (startLabel) startLabel.textContent = formatDateJP(calSelStart);
        if (endLabel) endLabel.textContent = '-';
        if (planBadge) planBadge.classList.add('hidden');
        if (confirmArea) confirmArea.classList.add('hidden');
        return;
    }
    if (guideEl) guideEl.classList.add('hidden');
    if (rangeEl) { rangeEl.classList.remove('hidden'); rangeEl.classList.add('flex'); }
    if (startLabel) startLabel.textContent = formatDateJP(calSelStart);
    if (endLabel) endLabel.textContent = formatDateJP(calSelEnd);

    if (hasBookedInRange(calSelStart, calSelEnd)) {
        if (planBadge) {
            planBadge.classList.remove('hidden');
            planBadge.textContent = '予約不可';
            planBadge.className = 'ml-2 px-3 py-1 text-[11px] font-black uppercase tracking-wider rounded-full bg-red-100 text-red-600';
        }
        if (confirmArea) confirmArea.classList.add('hidden');
        setTimeout(() => { calSelStart = null; calSelEnd = null; renderCalendar(); updateSelectionUI(); }, 1500);
        return;
    }

    const info = determinePlan(calSelStart, calSelEnd);
    if (planBadge) {
        planBadge.classList.remove('hidden');
        if (info.plan === 'weekly') {
            planBadge.className = 'ml-2 px-3 py-1 text-[11px] font-black uppercase tracking-wider rounded-full bg-orange-100 text-orange-600';
            planBadge.textContent = `ウィークリープラン ・ ${info.nights}泊`;
        } else if (info.plan === 'medium') {
            planBadge.className = 'ml-2 px-3 py-1 text-[11px] font-black uppercase tracking-wider rounded-full bg-blue-100 text-blue-600';
            planBadge.textContent = `ミディアムプラン ・ ${info.nights}泊`;
        } else {
            planBadge.className = 'ml-2 px-3 py-1 text-[11px] font-black uppercase tracking-wider rounded-full bg-black/10 text-black/70';
            planBadge.textContent = `ショートステイ ・ ${info.nights}泊`;
        }
    }

    if (confirmArea) confirmArea.classList.remove('hidden');
    if (planSummary) {
        const total = info.pricePerDay * info.nights;
        planSummary.innerHTML = `
            <p class="text-lg font-black mb-1">${info.name}</p>
            <p class="text-sm text-black/60">${formatDateJP(calSelStart)} 〜 ${formatDateJP(calSelEnd)}（${info.nights}泊）</p>
            <p class="text-2xl font-black mt-2">¥${total.toLocaleString()}<span class="text-sm text-black/40 font-bold ml-1">（税込）</span></p>
            <p class="text-xs text-black/40 mt-1">¥${info.pricePerDay.toLocaleString()}/日 × ${info.nights}泊</p>
        `;
    }
}

const calResetBtn = document.getElementById('cal-reset-btn');
if (calResetBtn) {
    calResetBtn.addEventListener('click', () => {
        calSelStart = null; calSelEnd = null;
        renderCalendar(); updateSelectionUI();
    });
}

function renderCalendar() {
    if (!calendarEl) return;
    calendarEl.innerHTML = '';
    const year = calCurrentMonth.getFullYear();
    const month = calCurrentMonth.getMonth();
    const today = new Date(); today.setHours(0,0,0,0);

    if (calMonthLabel) calMonthLabel.textContent = `${year}年 ${MONTH_NAMES[month]}`;

    WEEK_HEADS.forEach((d, i) => {
        const el = document.createElement('div');
        el.className = 'cal-head' + (i === 6 ? ' sun' : '') + (i === 5 ? ' sat' : '');
        el.textContent = d;
        calendarEl.appendChild(el);
    });

    const firstDay = new Date(year, month, 1);
    let startDow = firstDay.getDay();
    startDow = startDow === 0 ? 6 : startDow - 1;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < startDow; i++) {
        const el = document.createElement('div');
        el.className = 'cal-cell empty';
        calendarEl.appendChild(el);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const el = document.createElement('div');
        const dateObj = new Date(year, month, d);
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dow = (startDow + d - 1) % 7;

        let cls = 'cal-cell';
        if (dateObj < today) cls += ' past';
        else if (calBookedSet.has(dateStr)) cls += ' booked';
        else {
            cls += ' available';
            if (dow === 6) cls += ' sun';
            if (dow === 5) cls += ' sat';
        }
        if (dateObj.getTime() === today.getTime()) cls += ' today';
        if (calSelStart && dateStr === calSelStart) cls += ' cal-sel-start';
        if (calSelEnd && dateStr === calSelEnd) cls += ' cal-sel-end';
        if (calSelStart && calSelEnd && dateStr > calSelStart && dateStr < calSelEnd) cls += ' cal-sel-range';

        el.className = cls;
        el.textContent = d;

        if (cls.includes('available')) {
            el.addEventListener('click', () => {
                if (!calSelStart || (calSelStart && calSelEnd)) {
                    calSelStart = dateStr; calSelEnd = null;
                } else if (calSelStart && !calSelEnd) {
                    if (dateStr < calSelStart) {
                        calSelStart = dateStr;
                    } else if (dateStr === calSelStart) {
                        const next = new Date(parseDate(dateStr));
                        next.setDate(next.getDate() + 1);
                        calSelEnd = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`;
                    } else {
                        calSelEnd = dateStr;
                    }
                }
                renderCalendar(); updateSelectionUI();
            });
        }
        calendarEl.appendChild(el);
    }
    updateCalDots();
}

function getMonthRange() {
    const now = new Date();
    return {
        minMonth: new Date(now.getFullYear(), now.getMonth(), 1),
        maxMonth: new Date(now.getFullYear() + 1, now.getMonth(), 1)
    };
}
function canGoPrev() { const { minMonth } = getMonthRange(); return new Date(calCurrentMonth.getFullYear(), calCurrentMonth.getMonth()-1, 1) >= minMonth; }
function canGoNext() { const { maxMonth } = getMonthRange(); return new Date(calCurrentMonth.getFullYear(), calCurrentMonth.getMonth()+1, 1) <= maxMonth; }

function updateCalDots() {
    if (!calDots) return;
    calDots.innerHTML = '';
    const { minMonth, maxMonth } = getMonthRange();
    for (let m = new Date(minMonth); m <= maxMonth; m.setMonth(m.getMonth()+1)) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'cal-dot';
        dot.title = `${m.getFullYear()}年${MONTH_NAMES[m.getMonth()]}`;
        if (m.getFullYear() === calCurrentMonth.getFullYear() && m.getMonth() === calCurrentMonth.getMonth()) dot.classList.add('active');
        const y = m.getFullYear(), mo = m.getMonth();
        dot.addEventListener('click', () => { calCurrentMonth = new Date(y, mo, 1); renderCalendar(); });
        calDots.appendChild(dot);
    }
    if (calPrev) calPrev.style.opacity = canGoPrev() ? '1' : '.3';
    if (calNext) calNext.style.opacity = canGoNext() ? '1' : '.3';
}

if (calPrev) calPrev.addEventListener('click', () => { if (!canGoPrev()) return; calCurrentMonth.setMonth(calCurrentMonth.getMonth()-1); renderCalendar(); });
if (calNext) calNext.addEventListener('click', () => { if (!canGoNext()) return; calCurrentMonth.setMonth(calCurrentMonth.getMonth()+1); renderCalendar(); });

async function initCalendar() { await fetchBookedDates(); renderCalendar(); }
window.refreshCalendar = async function() { await fetchBookedDates(); renderCalendar(); };
if (calendarEl) initCalendar();

// --- 3. 予約フォーム モーダル制御 & API送信 ---
const openReserveBtn = document.getElementById('open-reserve');
const reserveModal = document.getElementById('reserve-modal');
const closeReserveBtn = document.getElementById('close-reserve');
const cancelReserveBtn = document.getElementById('cancel-reserve');
const reserveForm = document.getElementById('reserve-form');
const reserveMessage = document.getElementById('reserve-message');

function openReserve() {
    if (calSelStart && calSelEnd) {
        const startInput = document.querySelector('#reserve-form [name="start"]');
        const endInput = document.querySelector('#reserve-form [name="end"]');
        if (startInput) startInput.value = calSelStart;
        if (endInput) endInput.value = calSelEnd;

        const info = determinePlan(calSelStart, calSelEnd);
        const modalPlanInfo = document.getElementById('modal-plan-info');
        const modalPlanName = document.getElementById('modal-plan-name');
        const modalPlanDates = document.getElementById('modal-plan-dates');
        const modalPlanPrice = document.getElementById('modal-plan-price');
        const modalPlanDetail = document.getElementById('modal-plan-detail');
        if (modalPlanInfo) {
            modalPlanInfo.classList.remove('hidden');
            if (info.plan === 'weekly') {
                modalPlanInfo.className = 'mb-6 p-4 rounded-lg border-2 border-orange-500 bg-orange-50';
                if (modalPlanName) { modalPlanName.textContent = 'ウィークリープラン'; modalPlanName.className = 'text-xs font-black uppercase tracking-[0.2em] text-orange-500'; }
            } else if (info.plan === 'medium') {
                modalPlanInfo.className = 'mb-6 p-4 rounded-lg border-2 border-blue-400 bg-blue-50';
                if (modalPlanName) { modalPlanName.textContent = 'ミディアムプラン'; modalPlanName.className = 'text-xs font-black uppercase tracking-[0.2em] text-blue-500'; }
            } else {
                modalPlanInfo.className = 'mb-6 p-4 rounded-lg border-2 border-black/20 bg-gray-50';
                if (modalPlanName) { modalPlanName.textContent = 'ショートステイ'; modalPlanName.className = 'text-xs font-black uppercase tracking-[0.2em] text-black/60'; }
            }
            const total = info.pricePerDay * info.nights;
            if (modalPlanDates) modalPlanDates.textContent = `${formatDateJP(calSelStart)} 〜 ${formatDateJP(calSelEnd)}（${info.nights}泊）`;
            if (modalPlanPrice) modalPlanPrice.textContent = `¥${total.toLocaleString()}`;
            if (modalPlanDetail) modalPlanDetail.textContent = `¥${info.pricePerDay.toLocaleString()}/日 × ${info.nights}泊`;
        }
    }
    reserveModal.classList.remove('hidden');
    reserveModal.classList.add('flex');
    reserveModal.setAttribute('aria-hidden', 'false');
}

function closeReserve() {
    reserveModal.classList.add('hidden');
    reserveModal.classList.remove('flex');
    reserveModal.setAttribute('aria-hidden', 'true');
    reserveMessage.innerText = '';
    reserveForm.reset();
    const modalPlanInfo = document.getElementById('modal-plan-info');
    if (modalPlanInfo) modalPlanInfo.classList.add('hidden');
    calSelStart = null; calSelEnd = null;
    renderCalendar(); updateSelectionUI();
    const yakkanCb = document.getElementById('yakkan-agree');
    const submitBtn = document.getElementById('reserve-submit-btn');
    if (yakkanCb) yakkanCb.checked = false;
    if (submitBtn) submitBtn.disabled = true;
}

if (openReserveBtn) openReserveBtn.addEventListener('click', openReserve);
if (closeReserveBtn) closeReserveBtn.addEventListener('click', closeReserve);
if (cancelReserveBtn) cancelReserveBtn.addEventListener('click', closeReserve);


// 貸渡契約書チェック → 送信ボタン有効化
const yakkanCheckbox = document.getElementById('yakkan-agree');
const reserveSubmitBtn = document.getElementById('reserve-submit-btn');
if (yakkanCheckbox && reserveSubmitBtn) {
    yakkanCheckbox.addEventListener('change', () => {
        reserveSubmitBtn.disabled = !yakkanCheckbox.checked;
    });
}

// 約款モーダル
(function () {
    const openBtn = document.getElementById('open-yakkan-btn');
    const modal = document.getElementById('yakkan-modal');
    const closeBtn = document.getElementById('close-yakkan-btn');
    const okBtn = document.getElementById('yakkan-understood-btn');
    const body = document.getElementById('yakkan-modal-body');
    if (!openBtn || !modal) return;
    let loaded = false;
    function openYakkan() {
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        if (!loaded) {
            fetch('./yakkan-content.html')
                .then(r => r.ok ? r.text() : Promise.reject())
                .then(html => { body.innerHTML = html; loaded = true; })
                .catch(() => { body.innerHTML = '<p style="color:red;">読み込みに失敗しました。</p>'; });
        }
    }
    function closeYakkan() { modal.style.display = 'none'; document.body.style.overflow = ''; }
    openBtn.addEventListener('click', openYakkan);
    if (closeBtn) closeBtn.addEventListener('click', closeYakkan);
    if (okBtn) okBtn.addEventListener('click', closeYakkan);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeYakkan(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.style.display === 'flex') closeYakkan(); });
})();

// 決済完了・キャンセルのハンドリング（Stripeリダイレクト後）
(async () => {
    const params = new URLSearchParams(window.location.search);
    const booking = params.get('booking');
    const sessionId = params.get('session_id');
    const rid = params.get('rid');

    if (booking === 'success' && sessionId) {
        window.history.replaceState({}, '', window.location.pathname);
        try {
            const res = await fetch(`/api/confirm-payment?session_id=${encodeURIComponent(sessionId)}`);
            const data = await res.json();
            if (res.ok && data.ok) {
                showBookingSuccess(data);
            }
        } catch {}
    } else if (booking === 'cancelled' && rid) {
        fetch('/api/cancel-reservation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rid })
        }).catch(() => {});
        window.history.replaceState({}, '', window.location.pathname);
    }
})();

function showBookingSuccess(data) {
    const banner = document.getElementById('booking-success-banner');
    const detail = document.getElementById('booking-success-detail');
    const closeBtn = document.getElementById('booking-success-close');
    if (!banner) return;
    if (detail && data.name) {
        detail.textContent = `${data.name}様のご予約が確定しました。`;
    }
    banner.classList.remove('hidden');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => banner.classList.add('hidden'), { once: true });
    }
}

// 予約フォーム送信 → Stripe Checkout へリダイレクト
if (reserveForm) {
    reserveForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = document.getElementById('reserve-submit-btn');
        submitBtn.disabled = true;
        submitBtn.innerText = '処理中...';
        reserveMessage.innerText = '';
        reserveMessage.className = 'text-sm mt-2 text-center font-bold';

        const consent = document.getElementById('yakkan-agree')?.checked === true;
        if (!consent) {
            reserveMessage.innerText = '貸渡契約書・保証金の内容に同意してください。';
            reserveMessage.classList.add('text-red-500');
            submitBtn.disabled = false;
            submitBtn.innerText = 'お支払いへ進む';
            return;
        }

        const frontFile = reserveForm.querySelector('[name="license_front"]')?.files?.[0];
        const backFile  = reserveForm.querySelector('[name="license_back"]')?.files?.[0];
        if (!frontFile || !backFile) {
            reserveMessage.innerText = '運転免許証（表・裏）の画像をアップロードしてください。';
            reserveMessage.classList.add('text-red-500');
            submitBtn.disabled = false;
            submitBtn.innerText = 'お支払いへ進む';
            return;
        }

        const fd = new FormData();
        fd.append('name',  reserveForm.querySelector('[name="name"]').value.trim());
        fd.append('email', reserveForm.querySelector('[name="email"]').value.trim());
        fd.append('phone', reserveForm.querySelector('[name="phone"]').value.trim());
        fd.append('start', reserveForm.querySelector('[name="start"]').value);
        fd.append('end',   reserveForm.querySelector('[name="end"]').value);
        fd.append('consent', 'true');
        fd.append('license_front', frontFile);
        fd.append('license_back', backFile);

        try {
            const res = await fetch('/api/checkout-with-reservation', {
                method: 'POST',
                body: fd
            });
            const data = await res.json();
            if (res.ok && data.url) {
                window.location.href = data.url;
            } else {
                throw new Error(data.error || '送信に失敗しました');
            }
        } catch (err) {
            reserveMessage.innerText = err.message || '送信に失敗しました。もう一度お試しください。';
            reserveMessage.classList.add('text-red-500');
            submitBtn.disabled = false;
            submitBtn.innerText = 'お支払いへ進む';
        }
    });
}

// --- 5. お問い合わせフォーム → サーバーAPI ---
(function initContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;
    const submitBtn = document.getElementById('contact-submit-btn');
    const resultEl = document.getElementById('contact-message-result');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (submitBtn.disabled) return;
        submitBtn.disabled = true;
        submitBtn.textContent = '送信中...';
        resultEl.textContent = '';
        resultEl.className = 'text-sm font-bold text-center';

        const payload = {
            name: form.name.value.trim(),
            email: form.email.value.trim(),
            subject: form.subject.value.trim(),
            message: form.message.value.trim()
        };

        try {
            const res = await fetch('/api/contact', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok && data.ok) {
                resultEl.textContent = data.message || 'お問い合わせを送信しました。';
                resultEl.classList.add('text-green-600');
                form.reset();
            } else {
                throw new Error(data.error || '送信に失敗しました');
            }
        } catch (err) {
            resultEl.textContent = err.message || '通信エラーが発生しました。しばらくしてからお試しください。';
            resultEl.classList.add('text-red-500');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Send Message';
        }
    });
})();
