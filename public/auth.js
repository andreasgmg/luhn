// public/auth.js
const POCKETBASE_URL = 'http://luhn-pocketbase.services.coolify:8090';
const pb = new PocketBase(POCKETBASE_URL);

const registerForm = document.getElementById('register-form');
const loginForm = document.getElementById('login-form');
const logoutBtn = document.getElementById('logout-btn');
const profileContent = document.getElementById('profile-content');
const errorMessageP = document.getElementById('error-message');

// --- REGISTRATION ---
if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMessageP.textContent = '';

        const data = {
            "email": registerForm.email.value,
            "password": registerForm.password.value,
            "passwordConfirm": registerForm.passwordConfirm.value,
            "plan": "hobby", // Default plan
            "api_key": "pb_user_" + crypto.randomUUID().replace(/-/g, '')
        };

        try {
            await pb.collection('users').create(data);
            alert('Konto skapat! Du kan nu logga in.');
            window.location.href = '/login.html';
        } catch (err) {
            console.error('Registration Failed:', err);
            errorMessageP.textContent = 'Registrering misslyckades. ' + (err.data?.data?.email?.message || 'Kontrollera dina uppgifter.');
        }
    });
}

// --- LOGIN ---
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorMessageP.textContent = '';

        try {
            await pb.collection('users').authWithPassword(loginForm.email.value, loginForm.password.value);
            window.location.href = '/profile.html';
        } catch (err) {
            console.error('Login Failed:', err);
            errorMessageP.textContent = 'Inloggning misslyckades. Kontrollera e-post och lösenord.';
        }
    });
}

// --- LOGOUT ---
if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        pb.authStore.clear();
        window.location.href = '/';
    });
}

// --- PROFILE PAGE ---
if (profileContent) {
    if (!pb.authStore.isValid) {
        window.location.href = '/login.html';
    } else {
        const user = pb.authStore.model;
        profileContent.innerHTML = `
            <div class="profile-details">
                <p><strong>E-post:</strong> ${user.email}</p>
                <p><strong>Plan:</strong> <span class="plan-badge">${user.plan}</span></p>
                <hr>
                <h3>Din API-nyckel</h3>
                <p>Använd denna nyckel för att få tillgång till API:et.</p>
                <pre class="api-key-box">${user.api_key}</pre>
                <small>Denna nyckel är kopplad till din användare i Pocketbase.</small>
            </div>
        `;
    }
}
