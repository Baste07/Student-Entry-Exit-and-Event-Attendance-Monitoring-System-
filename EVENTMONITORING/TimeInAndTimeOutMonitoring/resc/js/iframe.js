/**
 * ============================================
 * LABORATORY ATTENDANCE SYSTEM - ADMIN PANEL
 * JavaScript for iframe.html
 * ============================================
 */

// ────────────────────────────────────────────
// AUTHENTICATION CHECK
// ────────────────────────────────────────────

let currentUser = null;

/**
 * Check if user is authenticated
 * Reads from sessionStorage and validates admin access
 */
function checkAuthentication() {
    const userDataStr = sessionStorage.getItem('user');
    
    if (!userDataStr) {
        console.log('❌ No session found');
        window.location.href = '../../auth/login.html';
        return false;
    }
    
    try {
        currentUser = JSON.parse(userDataStr);
        
        // Verify user is an admin
        if (currentUser.userType !== 'admin') {
            alert('Access denied. Admin account required.');
            logout();
            return false;
        }
        
        // Display user name in header
        const displayName = currentUser.firstName 
            ? `${currentUser.firstName} ${currentUser.lastName}`
            : currentUser.email;
        
        document.getElementById('userName').innerHTML = 
            `<i class="fa-solid fa-user-circle"></i> ${displayName}`;
        
        console.log('✅ Authenticated:', displayName);
        console.log('   User Type:', currentUser.userType);
        console.log('   Admin Level:', currentUser.adminLevel);
        
        return true;
        
    } catch (error) {
        console.error('Session error:', error);
        sessionStorage.removeItem('user');
        window.location.href = '../../auth/login.html';
        return false;
    }
}

// Run authentication check on page load
document.addEventListener('DOMContentLoaded', function() {
    if (checkAuthentication()) {
        setupRealtimeUpdates();
    }
});

// ────────────────────────────────────────────
// MANILA TIME CLOCK
// ────────────────────────────────────────────

/**
 * Update Manila time display
 * Shows current time in Manila timezone (Asia/Manila)
 */
function updateManilaTime() {
    const now = new Date();
    const manila = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Manila' }));
    
    // Format time as HH:MM:SS
    const hh = String(manila.getHours()).padStart(2, '0');
    const mm = String(manila.getMinutes()).padStart(2, '0');
    const ss = String(manila.getSeconds()).padStart(2, '0');
    
    document.getElementById('manilaTime').textContent = `${hh}:${mm}:${ss}`;
    
    // Format date as "Day, Month DD, YYYY"
    document.getElementById('manilaDate').textContent = manila.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

// Initialize clock and update every second
updateManilaTime();
setInterval(updateManilaTime, 1000);

// ────────────────────────────────────────────
// REAL-TIME UPDATES (SUPABASE)
// ────────────────────────────────────────────

/**
 * Setup real-time database subscriptions
 * Listens for changes in lab_sessions and lab_attendance tables
 */
function setupRealtimeUpdates() {
    if (!supabaseClient) {
        console.warn('⚠️  Supabase client not available');
        return;
    }
    
    const indicator = document.getElementById('statusIndicator');
    
    // Subscribe to database changes
    supabaseClient
        .channel('admin-updates')
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'lab_sessions'
            },
            (payload) => {
                console.log('📊 Session updated:', payload);
                
                // Show notification
                indicator.innerHTML = '<i class="fa-solid fa-check-circle" style="color:#1a7a4a;"></i> Session updated';
                indicator.classList.add('show');
                
                // Hide after 3 seconds
                setTimeout(() => {
                    indicator.classList.remove('show');
                }, 3000);
            }
        )
        .on(
            'postgres_changes',
            {
                event: '*',
                schema: 'public',
                table: 'lab_attendance'
            },
            (payload) => {
                console.log('✅ Attendance updated:', payload);
                
                // Show notification
                indicator.innerHTML = '<i class="fa-solid fa-check-circle" style="color:#1a7a4a;"></i> Attendance updated';
                indicator.classList.add('show');
                
                // Hide after 3 seconds
                setTimeout(() => {
                    indicator.classList.remove('show');
                }, 3000);
            }
        )
        .subscribe();

    console.log('✅ Real-time updates enabled');
}

// ────────────────────────────────────────────
// MENU ACTIVE STATE
// ────────────────────────────────────────────

/**
 * Handle menu item clicks
 * Updates active state when user navigates
 */
document.querySelectorAll('.menu-item').forEach(link => {
    link.addEventListener('click', function() {
        // Remove active class from all items
        document.querySelectorAll('.menu-item').forEach(l => {
            l.classList.remove('active');
        });
        
        // Add active class to clicked item
        this.classList.add('active');
    });
});

// ────────────────────────────────────────────
// LOGOUT FUNCTION
// ────────────────────────────────────────────

/**
 * Logout user
 * Clears session storage and redirects to login
 */
function logout() {
    if (confirm('Are you sure you want to log out?')) {
        // Clear session storage
        sessionStorage.removeItem('user');
        
        // Sign out from Supabase Auth
        if (supabaseClient && supabaseClient.auth) {
            supabaseClient.auth.signOut().catch((error) => {
                console.warn('Supabase sign out warning:', error);
            });
        }
        
        // Redirect to login page
        window.location.href = '../../auth/login.html';
    }
}

// ────────────────────────────────────────────
// UTILITY FUNCTIONS
// ────────────────────────────────────────────

/**
 * Show notification
 * @param {string} message - Message to display
 * @param {string} type - Type of notification (success, error, info)
 */
function showNotification(message, type = 'info') {
    const indicator = document.getElementById('statusIndicator');
    
    const icons = {
        success: '<i class="fa-solid fa-check-circle" style="color:#1a7a4a;"></i>',
        error: '<i class="fa-solid fa-exclamation-circle" style="color:#dc3545;"></i>',
        info: '<i class="fa-solid fa-info-circle" style="color:#0ea5e9;"></i>'
    };
    
    indicator.innerHTML = `${icons[type]} ${message}`;
    indicator.classList.add('show');
    
    setTimeout(() => {
        indicator.classList.remove('show');
    }, 3000);
}

/**
 * Get current user
 * @returns {Object|null} Current user object or null
 */
function getCurrentUser() {
    return currentUser;
}

// Export functions for use in other scripts
window.getCurrentUser = getCurrentUser;
window.showNotification = showNotification;
window.logout = logout;