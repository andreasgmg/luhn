function updateNavLinks() {
    const navLinksContainer = document.getElementById('nav-links-container');
    if (!navLinksContainer || !window.pb) return; // Ensure pb is available globally

    if (window.pb.authStore.isValid) {
        // User is logged in
        navLinksContainer.innerHTML = `
            <div class="nav-item">
                <a href="#">Generatorer</a>
                <div class="dropdown-menu">
                    <a href="/personnummer-generator">Personnummer</a>
                    <a href="/organisationsnummer-generator">Organisationsnummer</a>
                </div>
            </div>
            <a href="/docs">Dokumentation</a>
            <a href="/#pricing">Priser</a>
            <a href="/profile" style="margin-left: 30px;">Min Profil</a>
            <a href="#"><button id="logout-btn-nav" class="action-btn outline-btn" style="padding: 8px 16px; margin-left: 15px; font-size: 0.9rem;">Logga Ut</button></a>
        `;
        // Re-attach logout listener
        const logoutBtn = document.getElementById('logout-btn-nav');
        if(logoutBtn) {
            logoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                window.pb.authStore.clear();
                window.location.href = '/';
            });
        }
    } else {
        // User is logged out
        navLinksContainer.innerHTML = `
            <div class="nav-item">
                <a href="#">Generatorer</a>
                <div class="dropdown-menu">
                    <a href="/personnummer-generator">Personnummer</a>
                    <a href="/organisationsnummer-generator">Organisationsnummer</a>
                </div>
            </div>
            <a href="/docs">Dokumentation</a>
            <a href="/#pricing">Priser</a>
            <a href="mailto:hej@luhn.se">Kontakt</a>
            <a href="/login" style="margin-left: 30px;">Logga In</a>
            <a href="/register"><button class="action-btn" style="padding: 8px 16px; margin-left: 15px; font-size: 0.9rem;">Registrera</button></a>
        `;
    }
}

// Run on page load, but ensure pb is initialized
document.addEventListener('DOMContentLoaded', updateNavLinks);
