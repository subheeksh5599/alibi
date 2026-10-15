(function () {
  "use strict";

  var $ = function (q) { return document.querySelector(q); };
  var $$ = function (q) { return Array.prototype.slice.call(document.querySelectorAll(q)); };
  var isTouch = /iPad|iPhone|iPod|Android|BlackBerry|Opera Mini|IEMobile|webOS/i.test(navigator.userAgent);

  // header state + back-to-top
  var header = $("#header");
  var toTop = $(".back-to-top");
  function onScroll() {
    var y = window.scrollY;
    if (header) header.classList.toggle("header-scrolled", y > 100);
    if (toTop) toTop.classList.toggle("active", y > 100);
  }
  window.addEventListener("load", onScroll);
  document.addEventListener("scroll", onScroll, { passive: true });
  if (toTop) toTop.addEventListener("click", function () { window.scrollTo(0, 0); });

  // mobile navigation
  function toggleNav() {
    header.classList.toggle("pdtb-20");
    $("#navbar").classList.toggle("navbar-mobile");
    document.body.classList.toggle("overflow-hidden");
  }
  $$(".mobile-nav-toggle, .dropdown-off").forEach(function (el) { el.addEventListener("click", toggleNav); });
  $$(".navbar .dropdown > a").forEach(function (a) {
    a.addEventListener("click", function (e) {
      var sub = a.parentElement.querySelector(".dropdown-mobile");
      if ($("#navbar").classList.contains("navbar-mobile") && sub) {
        e.preventDefault();
        sub.classList.toggle("dropdown-active");
        var plus = a.querySelector(".bi-plus"), dash = a.querySelector(".bi-dash");
        if (plus) plus.classList.toggle("d-none");
        if (dash) dash.classList.toggle("d-block");
      }
    });
  });
  // in-page links close the mobile menu and clear the fixed header
  $$('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var id = a.getAttribute("href");
      var t = id.length > 1 && document.querySelector(id);
      if (!t) return;
      if (a.parentElement && a.parentElement.classList.contains("dropdown") && $("#navbar").classList.contains("navbar-mobile") &&
          a.parentElement.querySelector(".dropdown-mobile")) return;
      e.preventDefault();
      if ($("#navbar").classList.contains("navbar-mobile")) toggleNav();
      var off = header ? header.offsetHeight : 0;
      window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - off, behavior: "smooth" });
    });
  });

  window.addEventListener("load", function () {
    if (window.AOS) AOS.init({ delay: 0, duration: 800, easing: "ease-in-out", offset: -180, once: true, mirror: false });
  });

  if (!window.Swiper) return;

  // announcement strip
  [".brandoverview-swiper", ".brandoverview-swiper-m"].forEach(function (sel, i) {
    var el = $(sel);
    if (!el) return;
    var many = el.querySelectorAll(".swiper-slide").length > 1;
    new Swiper(sel, Object.assign({ speed: 6000, loop: true, slidesPerView: "auto",
      autoplay: many ? { delay: 500, disableOnInteraction: false } : false }, i === 0 ? { direction: "vertical" } : {}));
  });

  // stack strip: continuous marquee that holds position under the pointer
  function marquee(sel, wrapperId, speed, slideWidth, opts) {
    var sw = new Swiper(sel, Object.assign({
      speed: speed, loop: true, freeMode: true, allowTouchMove: false, slidesPerView: "auto",
      autoplay: { delay: 0, disableOnInteraction: false, stopOnLastSlide: false, pauseOnMouseEnter: true },
      loopFillGroupWithBlank: true, normalizeSlideIndex: true
    }, opts));
    if (isTouch) return sw;
    var wrap = document.getElementById(wrapperId);
    var nextTf = "", nextTime = 0;
    function tx(s) { var m = /translate3d\((-?[\d.]+)px/.exec(s); return m ? parseFloat(m[1]) : 0; }
    sw.el.addEventListener("mouseover", function () {
      nextTf = wrap.style.transform;
      var nowTf = getComputedStyle(wrap).transform;
      var now = new DOMMatrix(nowTf).m41;
      var w = slideWidth || parseFloat(wrap.querySelector(".swiper-slide").style.width) || 1;
      nextTime = speed * Math.abs((tx(nextTf) - now) / w);
      wrap.style.transform = nowTf;
      wrap.style.transitionDuration = "0ms";
      sw.autoplay.stop();
    });
    sw.el.addEventListener("mouseout", function () {
      wrap.style.transform = nextTf;
      wrap.style.transitionDuration = nextTime + "ms";
      sw.autoplay.start();
    });
    return sw;
  }

  if ($(".backed-slider")) {
    marquee(".backed-slider", "backed-swiper-wrapper", 4000, 0, {
      pagination: { el: ".swiper-pagination", type: "bullets", clickable: true },
      breakpoints: {
        320: { slidesPerView: 3, spaceBetween: 20 }, 480: { slidesPerView: 4, spaceBetween: 20 },
        640: { slidesPerView: 4, spaceBetween: 20 }, 720: { slidesPerView: 8, spaceBetween: 20 },
        992: { slidesPerView: 8, spaceBetween: 25 }, 1200: { slidesPerView: 8, spaceBetween: 25 },
        1440: { slidesPerView: 10, spaceBetween: 25 }, 1920: { slidesPerView: 14, spaceBetween: 25 }
      }
    });
  }

  if (isTouch && $(".enumera-mobile-list")) {
    new Swiper(".enumera-mobile-list", {
      speed: 500, loop: true, autoplay: { delay: 3000, disableOnInteraction: false }, slidesPerView: "auto",
      pagination: { el: ".enumera-mobile-pagination" },
      breakpoints: { 320: { slidesPerView: 1, spaceBetween: 30 }, 720: { slidesPerView: 2, spaceBetween: 30 }, 992: { slidesPerView: 3, spaceBetween: 30 } }
    });
  }

  if ($(".trusted-slider")) {
    var bp = { 320: { slidesPerView: 1, spaceBetween: 20 }, 720: { slidesPerView: 2, spaceBetween: 20 }, 992: { spaceBetween: 30 } };
    if (isTouch) {
      new Swiper(".trusted-slider", { loop: true, slidesPerView: "auto", speed: 1000,
        autoplay: { delay: 3000, disableOnInteraction: false }, pagination: { el: ".swiper-pagination-trusted" }, breakpoints: bp });
    } else {
      var started = false;
      var start = function () {
        if (started) return;
        started = true;
        marquee(".trusted-slider", "trusted-swiper-wrapper", 8000, 525, { breakpoints: bp });
      };
      document.addEventListener("aos:in:trusted-swiper", start);
      var el = $(".trusted-slider");
      if (!("IntersectionObserver" in window)) start();
      else new IntersectionObserver(function (es, ob) {
        if (es.some(function (e) { return e.isIntersecting; })) { ob.disconnect(); start(); }
      }).observe(el);
    }
  }
})();
