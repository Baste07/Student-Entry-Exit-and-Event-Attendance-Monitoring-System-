(function () {
    let modal;
    let previousFocus;

    function createModal() {
        if (modal) return;

        modal = document.createElement('div');
        modal.className = 'logout-modal-backdrop';
        modal.innerHTML = `
            <div class="logout-modal-dialog" role="dialog" aria-modal="true"
                 aria-labelledby="logoutModalTitle">
                <h2 id="logoutModalTitle">Log out?</h2>
                <p>Are you sure you want to log out?</p>
                <div class="logout-modal-actions">
                    <button type="button" class="logout-modal-cancel">Cancel</button>
                    <button type="button" class="logout-modal-confirm">Log Out</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        modal.querySelector('.logout-modal-cancel')
            .addEventListener('click', closeLogoutModal);

        modal.querySelector('.logout-modal-confirm')
            .addEventListener('click', confirmLogout);

        modal.addEventListener('click', event => {
            if (event.target === modal) closeLogoutModal();
        });
    }

    function handleKeydown(event) {
        if (event.key === 'Escape') closeLogoutModal();
    }

    window.openLogoutModal = function () {
        createModal();
        previousFocus = document.activeElement;
        modal.classList.add('is-open');
        modal.querySelector('.logout-modal-cancel').focus();
        document.addEventListener('keydown', handleKeydown);
    };

    window.closeLogoutModal = function () {
        if (!modal) return;

        modal.classList.remove('is-open');
        document.removeEventListener('keydown', handleKeydown);

        if (previousFocus && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
    };

    async function confirmLogout() {
        const button = modal.querySelector('.logout-modal-confirm');
        button.disabled = true;
        button.textContent = 'Logging out...';

        try {
            if (typeof supabaseClient !== 'undefined' &&
                supabaseClient?.auth) {
                await supabaseClient.auth.signOut();
            }
        } catch (error) {
            console.warn('Sign-out warning:', error);
        } finally {
            sessionStorage.clear();
            localStorage.clear();
            window.location.href =
                '/CAPSTONEFINAL/EVENTMONITORING/auth/login.html';
        }
    }

    // Used by both injected module headers.
    window.logout = window.openLogoutModal;
})();