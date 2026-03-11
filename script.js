/* ============================================
   ENVISION LEGACY — Script
   ============================================ */

(() => {
    'use strict';

    // --- Photo Data ---
    const photoData = [
        {
            title: "Grandma's Porch",
            date: "1947",
            caption: "Grandma's Porch, 1947",
            description: "A grandmother and her grandchild sharing a quiet moment on the porch swing. These are the moments that define a lifetime — the warmth of her embrace, the creak of the swing, the scent of fresh-baked pie drifting through the screen door.",
            image: "images/grandma_child.png"
        },
        {
            title: "First Ride",
            date: "1954",
            caption: "First Ride, 1954",
            description: "A father's steady hand guiding his son on a first bicycle ride down a tree-lined street. That perfect balance between holding on and letting go — the very essence of parenthood captured in a single frame.",
            image: "images/father_son_bike.png"
        },
        {
            title: "The Dance",
            date: "1963",
            caption: "The Dance, 1963",
            description: "Two people lost in each other at a backyard gathering, string lights painting the evening gold. The music has long since faded, but the feeling of that dance lives on in everyone who witnessed it.",
            image: "images/couple_dancing.png"
        },
        {
            title: "Welcome Home",
            date: "1945",
            caption: "Welcome Home, 1945",
            description: "A soldier's return — that electric moment of reunion at Track 7. After years of letters and prayers, the embrace that made the whole world disappear. Some homecomings change everything.",
            image: "images/soldiers_homecoming.png"
        },
        {
            title: "Sunday in the Park",
            date: "1955",
            caption: "Sunday in the Park, 1955",
            description: "The whole family gathered for a picnic by the lake — cousins, aunts, uncles, everyone. Cold fried chicken, checkered blankets, and laughter that echoed across the water. The good old days.",
            image: "images/family_picnic.png"
        },
        {
            title: "At the Lake",
            date: "1962",
            caption: "At the Lake, 1962",
            description: "Grandpa and his grandson at their favorite fishing spot as the sun melts into the horizon. He'd say the fish weren't biting, but that was never really the point. It was always about the stories.",
            image: "images/grandpa_fishing.png"
        },
        {
            title: "The Wedding",
            date: "1948",
            caption: "The Wedding, 1948",
            description: "Standing before the little stone church, a promise made for a lifetime. The bouquet she carried was from her mother's garden, and the suit he wore was his father's. Some traditions are worth keeping.",
            image: "images/wedding_portrait.png"
        },
        {
            title: "Morning Ritual",
            date: "1952",
            caption: "Morning Ritual, 1952",
            description: "A mother braiding her daughter's hair in the warm morning light of the kitchen. The smell of coffee, the gentle tug of the comb, a quiet conversation about the day ahead. Pure, unhurried love.",
            image: "images/mother_daughter.png"
        },
        {
            title: "Summer Days",
            date: "1965",
            caption: "Summer Days, 1965",
            description: "Barefoot kids chasing each other through the sprinkler on the hottest day of the year. No screens, no schedules — just the simple joy of cold water and green grass and unending summer afternoons.",
            image: "images/kids_playing.png"
        },
        {
            title: "Make a Wish",
            date: "1957",
            caption: "Make a Wish, 1957",
            description: "The whole room lit by candlelight as she takes a breath to blow. Every face around that table beaming with love. What did she wish for? She never told, but some wishes come true all on their own.",
            image: "images/birthday_party.png"
        },
        {
            title: "Golden Years",
            date: "1974",
            caption: "Golden Years, 1974",
            description: "Fifty years and still holding hands on their favorite park bench, watching the sunset paint the sky in shades they'd seen a thousand times but never tired of. That's the real legacy — enduring love.",
            image: "images/elderly_couple_bench.png"
        },
        {
            title: "Graduation Day",
            date: "1966",
            caption: "Graduation Day, 1966",
            description: "The hug that said everything words couldn't. Years of sacrifice, late nights, and belief in her dreams — all worth it in this single, perfect moment. A father's pride, a daughter's triumph.",
            image: "images/graduation_day.png"
        }
    ];

    // --- DOM Elements ---
    const nav = document.getElementById('main-nav');
    const detailModal = document.getElementById('detail-modal');
    const modalBackdrop = document.getElementById('modal-backdrop');
    const modalClose = document.getElementById('modal-close');
    const modalImage = document.getElementById('modal-image');
    const modalVideo = document.getElementById('modal-video');
    const modalTitle = document.getElementById('modal-title');
    const modalDate = document.getElementById('modal-date');
    const modalDescription = document.getElementById('modal-description');
    const videoLoader = document.getElementById('video-loader');
    const toggleSwitch = document.getElementById('toggle-switch');
    const toggleOriginal = document.getElementById('toggle-original');
    const toggleAnimated = document.getElementById('toggle-animated');
    const cards = document.querySelectorAll('.polaroid-card');

    // --- State ---
    let isAnimated = false;
    let currentPhotoIndex = -1;
    const videoCache = {};

    // --- Nav scroll behavior ---
    let lastScroll = 0;
    window.addEventListener('scroll', () => {
        const scrollY = window.scrollY;

        if (scrollY > 50) {
            nav.classList.add('scrolled');
        } else {
            nav.classList.remove('scrolled');
        }

        lastScroll = scrollY;
    }, { passive: true });

    // --- Smooth scroll for anchor links ---
    document.querySelectorAll('a[href^="#"]').forEach(link => {
        link.addEventListener('click', (e) => {
            const target = document.querySelector(link.getAttribute('href'));
            if (target) {
                e.preventDefault();
                const offset = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-height')) || 72;
                const top = target.getBoundingClientRect().top + window.scrollY - offset;
                window.scrollTo({ top, behavior: 'smooth' });
            }
        });
    });

    // --- Scroll Reveal (Intersection Observer) ---
    const revealObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry, i) => {
            if (entry.isIntersecting) {
                // Stagger the animation
                const delay = entry.target.dataset.revealDelay || 0;
                setTimeout(() => {
                    entry.target.classList.add('visible');
                }, delay);
                revealObserver.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    // Observe polaroid cards with staggered delays
    cards.forEach((card, i) => {
        card.dataset.revealDelay = i * 80;
        revealObserver.observe(card);
    });

    // Observe service cards
    document.querySelectorAll('.service-card').forEach((card, i) => {
        card.dataset.revealDelay = i * 100;
        revealObserver.observe(card);
    });

    // --- Video URL check ---
    async function getVideoUrl(index) {
        if (index in videoCache) {
            return videoCache[index] || null;
        }

        const imageName = photoData[index].image
            .replace('images/', '')
            .replace('.png', '');
        const videoUrl = `videos/${imageName}.mp4`;

        try {
            const resp = await fetch(videoUrl, { method: 'HEAD' });
            if (resp.ok) {
                videoCache[index] = videoUrl;
                return videoUrl;
            }
        } catch (e) {
            // Network error — assume no video
        }

        videoCache[index] = false;
        return null;
    }

    // --- Card Clicks (open detail) ---
    cards.forEach((card, index) => {
        card.addEventListener('click', () => {
            const data = photoData[index];
            if (!data) return;
            currentPhotoIndex = index;
            openDetail(data);
        });
    });

    // --- Detail Modal ---
    function openDetail(data) {
        modalTitle.textContent = data.title;
        modalDate.textContent = data.date;
        modalDescription.textContent = data.description;
        modalImage.src = data.image;
        modalImage.alt = data.title;

        // Reset toggle — show original image
        isAnimated = false;
        modalImage.style.display = 'block';
        modalImage.classList.remove('animated');
        modalVideo.style.display = 'none';
        modalVideo.pause();
        modalVideo.removeAttribute('src');
        videoLoader.style.display = 'none';
        toggleSwitch.classList.remove('active');
        toggleOriginal.classList.add('active');
        toggleAnimated.classList.remove('active');

        // Remove any leftover no-video badge
        const oldBadge = document.querySelector('.no-video-badge');
        if (oldBadge) oldBadge.remove();

        detailModal.classList.remove('modal-hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeDetail() {
        detailModal.classList.add('modal-hidden');
        modalVideo.pause();
        document.body.style.overflow = '';
    }

    modalClose.addEventListener('click', closeDetail);
    modalBackdrop.addEventListener('click', closeDetail);

    // --- Animation Toggle (Veo 3 video playback) ---
    async function toggleAnimation() {
        isAnimated = !isAnimated;

        // Remove any no-video badge
        const oldBadge = document.querySelector('.no-video-badge');
        if (oldBadge) oldBadge.remove();

        if (isAnimated) {
            toggleSwitch.classList.add('active');
            toggleOriginal.classList.remove('active');
            toggleAnimated.classList.add('active');

            // Check for pre-generated video
            const url = await getVideoUrl(currentPhotoIndex);

            if (url) {
                // Show video, hide image
                modalVideo.src = url;
                modalVideo.style.display = 'block';
                modalImage.style.display = 'none';
                modalVideo.play().catch(() => {});
            } else {
                // No video available — show CSS fallback + badge
                modalImage.classList.add('animated');
                const badge = document.createElement('div');
                badge.className = 'no-video-badge';
                badge.textContent = 'AI video not yet generated — showing preview';
                document.getElementById('modal-image-frame').appendChild(badge);
                setTimeout(() => badge.remove(), 4000);
            }
        } else {
            toggleSwitch.classList.remove('active');
            toggleOriginal.classList.add('active');
            toggleAnimated.classList.remove('active');

            // Show image, hide video
            modalImage.style.display = 'block';
            modalImage.classList.remove('animated');
            modalVideo.style.display = 'none';
            modalVideo.pause();
        }
    }

    toggleSwitch.addEventListener('click', toggleAnimation);
    toggleOriginal.addEventListener('click', () => { if (isAnimated) toggleAnimation(); });
    toggleAnimated.addEventListener('click', () => { if (!isAnimated) toggleAnimation(); });

    // --- Keyboard ---
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (!detailModal.classList.contains('modal-hidden')) {
                closeDetail();
            }
        }
    });

    // --- Mobile Menu Toggle ---
    const mobileBtn = document.getElementById('mobile-menu-btn');
    const navLinks = document.querySelector('.nav-links');

    if (mobileBtn && navLinks) {
        mobileBtn.addEventListener('click', () => {
            navLinks.classList.toggle('mobile-open');
        });
    }

    // --- Signup Form (Formspree AJAX) ---
    const signupForm = document.getElementById('signup-form');
    const formSuccess = document.getElementById('form-success');

    if (signupForm) {
        signupForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitBtn = signupForm.querySelector('.btn-submit');
            const originalHTML = submitBtn.innerHTML;
            submitBtn.innerHTML = '<span>Sending...</span>';
            submitBtn.disabled = true;

            try {
                const formData = new FormData(signupForm);
                const res = await fetch(signupForm.action, {
                    method: 'POST',
                    body: formData,
                    headers: { 'Accept': 'application/json' }
                });

                if (res.ok) {
                    signupForm.style.display = 'none';
                    formSuccess.style.display = 'block';
                } else {
                    submitBtn.innerHTML = '<span>Something went wrong — try again</span>';
                    submitBtn.disabled = false;
                    setTimeout(() => { submitBtn.innerHTML = originalHTML; }, 3000);
                }
            } catch (err) {
                submitBtn.innerHTML = '<span>Network error — try again</span>';
                submitBtn.disabled = false;
                setTimeout(() => { submitBtn.innerHTML = originalHTML; }, 3000);
            }
        });
    }

})();
