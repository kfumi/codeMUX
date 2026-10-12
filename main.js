const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector("#primary-navigation");

if (menuButton && navigation) {
  const closeMenu = () => {
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "打开导航菜单");
    navigation.classList.remove("is-open");
  };

  menuButton.addEventListener("click", () => {
    const isExpanded = menuButton.getAttribute("aria-expanded") === "true";
    menuButton.setAttribute("aria-expanded", String(!isExpanded));
    menuButton.setAttribute("aria-label", isExpanded ? "打开导航菜单" : "关闭导航菜单");
    navigation.classList.toggle("is-open", !isExpanded);
  });

  navigation.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeMenu);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
      menuButton.focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (!navigation.contains(event.target) && !menuButton.contains(event.target)) {
      closeMenu();
    }
  });
}

// 滚动时让首屏标题与工作台截图拉开景深，其他内容按阅读顺序进入画面。
if (window.gsap && window.ScrollTrigger) {
  gsap.registerPlugin(ScrollTrigger);

  const landingMotion = gsap.matchMedia();

  landingMotion.add("(prefers-reduced-motion: no-preference)", () => {
    const hero = document.querySelector("[data-hero-stage]");

    if (hero) {
      gsap.timeline({ defaults: { ease: "power2.out" } })
        .fromTo(hero.querySelector(".hero-copy"),
          { autoAlpha: 0, y: 14 },
          { autoAlpha: 1, y: 0, duration: 0.58 },
        )
        .fromTo(hero.querySelector(".product-window"),
          { autoAlpha: 0, clipPath: "inset(0 0 0 100%)" },
          { autoAlpha: 1, clipPath: "inset(0 0 0 0)", duration: 0.78 },
          0.12,
        )
        .fromTo(hero.querySelector(".hero-caption"),
          { autoAlpha: 0, y: 7 },
          { autoAlpha: 1, y: 0, duration: 0.4 },
          0.48,
        );
    }

    const featureCards = gsap.utils.toArray(".feature-card[data-reveal]");
    if (featureCards.length) {
      gsap.fromTo(featureCards,
        { autoAlpha: 0, y: 22 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.72,
          stagger: 0.11,
          ease: "power2.out",
          scrollTrigger: {
            trigger: ".feature-grid",
            start: "top 79%",
            toggleActions: "play none none none",
          },
        },
      );
    }

    gsap.utils.toArray("[data-reveal]:not(.feature-card)").forEach((element) => {
      gsap.fromTo(element,
        { autoAlpha: 0, y: 20 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.68,
          ease: "power2.out",
          scrollTrigger: {
            trigger: element,
            start: "top 84%",
            toggleActions: "play none none none",
          },
        },
      );
    });

    const reviewImage = document.querySelector(".review-frame > img");
    if (reviewImage) {
      gsap.fromTo(reviewImage,
        { clipPath: "inset(0 100% 0 0)" },
        {
          clipPath: "inset(0 0% 0 0)",
          duration: 0.85,
          ease: "power2.out",
          scrollTrigger: {
            trigger: reviewImage,
            start: "top 83%",
            toggleActions: "play none none none",
          },
        },
      );
    }
  });

  // 只有双栏首屏启用钉住滚动；窄屏保留自然纵向浏览。
  const desktopHeroMotion = gsap.matchMedia();
  desktopHeroMotion.add("(min-width: 981px) and (prefers-reduced-motion: no-preference)", () => {
    const hero = document.querySelector("[data-hero-stage]");
    if (!hero) return;

    gsap.timeline({
      scrollTrigger: {
        trigger: hero,
        start: "top 72px",
        end: () => `+=${Math.round(window.innerHeight * 0.9)}`,
        pin: true,
        pinSpacing: true,
        scrub: 0.55,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      },
    })
      .to(hero.querySelector(".hero-copy"), {
        scale: 1.045,
        y: -5,
        transformOrigin: "left center",
        ease: "none",
      }, 0)
      .to(hero.querySelector(".hero-art"), {
        scale: 0.88,
        x: 10,
        y: 8,
        transformOrigin: "70% 50%",
        ease: "none",
      }, 0);
  });

  window.addEventListener("load", () => ScrollTrigger.refresh(), { once: true });
}
