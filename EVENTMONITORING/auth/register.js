let currentStep = 1;
const totalSteps = 2;

const form = document.getElementById('registrationForm');
const backBtn = document.getElementById('backBtn');
const nextBtn = document.getElementById('nextBtn');
const prevBtn = document.getElementById('prevBtn');
const submitBtn = document.getElementById('submitBtn');

let departmentsLoaded = false;  

document.addEventListener('DOMContentLoaded', function() {
    setupPasswordToggles();
    setupFormNavigation();
    setupFormValidation();
    setupUserTypeToggle();
    loadDepartmentsForRegistration();
});

function setupPasswordToggles() {
    const toggleButtons = document.querySelectorAll('.toggle-password');
    
    toggleButtons.forEach(toggle => {
        toggle.addEventListener('click', function() {
            const targetId = this.getAttribute('data-target');
            const passwordField = document.getElementById(targetId);
            
            if (passwordField.type === 'password') {
                passwordField.type = 'text';
                this.innerHTML = `
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                `;
            } else {
                passwordField.type = 'password';
                this.innerHTML = `
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                `;
            }
        });
    });
}

function setupFormNavigation() {
    backBtn.addEventListener('click', function() {
        window.location.href = 'login.html';
    });

    nextBtn.addEventListener('click', function() {
        if (validateStep(currentStep)) {
            goToStep(currentStep + 1);
        }
    });

    prevBtn.addEventListener('click', function() {
        goToStep(currentStep - 1);
    });

    form.addEventListener('submit', function(e) {
        e.preventDefault();
        
        if (validateStep(currentStep)) {
            submitRegistration();
        }
    });
}

function goToStep(stepNumber) {
    if (stepNumber < 1 || stepNumber > totalSteps) return;

    document.querySelector(`.form-step[data-step="${currentStep}"]`).classList.remove('active');
    document.querySelector(`.step[data-step="${currentStep}"]`).classList.remove('active');
    currentStep = stepNumber;
    document.querySelector(`.form-step[data-step="${currentStep}"]`).classList.add('active');
    document.querySelector(`.step[data-step="${currentStep}"]`).classList.add('active');
    updateNavigationButtons();
}

function updateNavigationButtons() {
    if (currentStep === 1) {
        backBtn.style.display = 'flex';
        nextBtn.style.display = 'flex';
        prevBtn.style.display = 'none';
        submitBtn.style.display = 'none';
    } else if (currentStep === totalSteps) {
        backBtn.style.display = 'none';
        nextBtn.style.display = 'none';
        prevBtn.style.display = 'flex';
        submitBtn.style.display = 'flex';
    }
}

function validateStep(step) {
    const currentStepElement = document.querySelector(`.form-step[data-step="${step}"]`);
    const inputs = currentStepElement.querySelectorAll('input[required], select[required]');
    let isValid = true;

    inputs.forEach(input => {
        // Skip validation for hidden fields
        if (input.offsetParent === null || input.parentElement.offsetParent === null || 
            (input.parentElement.parentElement && input.parentElement.parentElement.style.display === 'none')) {
            return;
        }
        
        if (!validateField(input)) {
            isValid = false;
        }
    });

    if (step === 2) {
        const password = document.getElementById('password');
        const confirmPassword = document.getElementById('confirmPassword');
        
        if (password.value !== confirmPassword.value) {
            showError(confirmPassword, 'Passwords do not match');
            isValid = false;
        }

        const email = document.getElementById('email');
        const emailPattern = /^[^\s@]+@plpasig\.edu\.ph$/;
        if (!emailPattern.test(email.value)) {
            showError(email, 'Please use your institutional email (@plpasig.edu.ph)');
            isValid = false;
        }
    }

    return isValid;
}

function validateField(field) {
    const value = field.value.trim();
    clearError(field);

    if (field.hasAttribute('required') && !value) {
        showError(field, 'This field is required');
        return false;
    }

    if (field.type === 'email') {
        const emailPattern = /^[^\s@]+@plpasig\.edu\.ph$/;
        if (!emailPattern.test(value)) {
            showError(field, 'Please use your institutional email (@plpasig.edu.ph)');
            return false;
        }
    }

    if (field.hasAttribute('minlength')) {
        const minLength = parseInt(field.getAttribute('minlength'));
        if (value.length < minLength) {
            showError(field, `Must be at least ${minLength} characters`);
            return false;
        }
    }

    field.classList.remove('is-invalid');
    field.classList.add('is-valid');
    return true;
}

function showError(field, message) {
    field.classList.add('is-invalid');
    field.classList.remove('is-valid');
    
    const existingError = field.parentElement.querySelector('.invalid-feedback');
    if (existingError) {
        existingError.remove();
    }

    const errorDiv = document.createElement('div');
    errorDiv.className = 'invalid-feedback';
    errorDiv.textContent = message;
    
    if (field.parentElement.classList.contains('input-wrapper')) {
        field.parentElement.parentElement.appendChild(errorDiv);
    } else {
        field.parentElement.appendChild(errorDiv);
    }
}

function clearError(field) {
    field.classList.remove('is-invalid', 'is-valid');
    const errorDiv = field.parentElement.querySelector('.invalid-feedback') || 
                    field.parentElement.parentElement.querySelector('.invalid-feedback');
    if (errorDiv) {
        errorDiv.remove();
    }
}

function setupFormValidation() {
    const inputs = form.querySelectorAll('input, select');
    
    inputs.forEach(input => {
        input.addEventListener('blur', function() {
            if (this.value.trim()) {
                validateField(this);
            }
        });

        input.addEventListener('input', function() {
            if (this.classList.contains('is-invalid')) {
                clearError(this);
            }
        });
    });

    const confirmPassword = document.getElementById('confirmPassword');
    confirmPassword.addEventListener('input', function() {
        const password = document.getElementById('password');
        if (this.value && password.value !== this.value) {
            showError(this, 'Passwords do not match');
        } else if (this.value && password.value === this.value) {
            clearError(this);
            this.classList.add('is-valid');
        }
    });
}
function setupUserTypeToggle() {
    const userTypeSelect = document.getElementById('userType');
    const roleField = document.getElementById('roleField');
    const employeeIdField = document.getElementById('employeeIdField');
    const nameFields = document.getElementById('nameFields');
    const firstNameLabel = document.getElementById('firstNameLabel');
    const firstNameInput = document.getElementById('firstName');
    const middleNameField = document.getElementById('middleNameField');
    const lastNameField = document.getElementById('lastNameField');
    const lastNameInput = document.getElementById('lastName');
    const departmentField = document.getElementById('departmentField');
    const departmentSelect = document.getElementById('department');
    
    // Default to professor layout
    roleField.style.display = 'block';
    employeeIdField.style.display = 'block';
    middleNameField.style.display = 'block';
    lastNameField.style.display = 'block';
    departmentField.style.display = 'block';
    if (departmentSelect) departmentSelect.setAttribute('required', 'required');
    if (firstNameLabel) firstNameLabel.textContent = 'First Name';
    firstNameInput.placeholder = 'First name';
    lastNameInput.setAttribute('required', 'required');
    nameFields.classList.add('row');
    firstNameInput.parentElement.classList.add('col-md-4');
}

async function loadDepartmentsForRegistration() {
    try {
        if (!supabaseClient) {
            console.error('Supabase client not initialized');
            return;
        }

        const { data: departments, error } = await supabaseClient
            .from('departments')
            .select('id, department_name, department_code')
            .eq('is_active', true)
            .order('department_name', { ascending: true });

        if (error) throw error;

        const departmentSelect = document.getElementById('department');
        if (departmentSelect && departments && departments.length > 0) {
            departments.forEach(dept => {
                const option = document.createElement('option');
                option.value = dept.id;
                option.textContent = `${dept.department_name} (${dept.department_code})`;
                departmentSelect.appendChild(option);
            });
            departmentsLoaded = true; // Mark as loaded
            console.log('Departments loaded successfully');
        }
    } catch (error) {
        console.error('Error loading departments for registration:', error);
    }
}

async function submitRegistration() {
    const userType = 'professor'; // Default to professor
    if (!departmentsLoaded) {
        alert('Please wait for departments to load before submitting. Try again in a moment.');
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Registering...';

    const employeeId = document.getElementById('employeeId').value.trim();
    const firstName = document.getElementById('firstName').value.trim();
    const middleName = document.getElementById('middleName').value.trim();
    const lastName = document.getElementById('lastName').value.trim();
    const suffix = document.getElementById('suffix').value.trim();
    const role = document.getElementById('role').value;
    const department = document.getElementById('department').value;
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    // Additional validation for professors
    if (!department) {
        alert('Please select a department');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Complete Registration';
        return;
    }

    console.log('Registration data:', { userType, email, department }); 

    try {
        if (!supabaseClient) {
            throw new Error('Database connection not available. Please check configuration.');
        }
        const { data: existingProfessor } = await supabaseClient
            .from('professors')
            .select('email')
            .eq('email', email)
            .maybeSingle();

        if (existingProfessor) {
            alert('An account with this email already exists.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Complete Registration';
            return;
        }

        const { data: authData, error: authError } = await supabaseClient.auth.signUp({
            email: email,
            password: password
        });

        if (authError) throw authError;
        if (!authData.user) throw new Error('Failed to create auth user.');

        const authUserId = authData.user.id;

        let result;
        let successMessage;

        result = await supabaseClient
            .from('professors')
            .insert([{
                professor_id: authUserId,
                employee_id: employeeId,
                first_name: firstName,
                middle_name: middleName || null,
                last_name: lastName || null,
                suffix: suffix || null,
                email: email,
                password: password,
                role: role,
                department_id: department || null,
                status: 'inactive',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }]);

        successMessage = 'Registration successful! Your account is pending admin approval.';

        if (result.error) {
            console.error('Database insert error:', result.error); // Debug log
            await supabaseClient.auth.admin.deleteUser(authUserId);
            throw result.error;
        }

        alert(successMessage);
        setTimeout(() => {
            window.location.href = 'login.html';
        }, 1000);

    } catch (error) {
        console.error('Registration error:', error);
        console.error('Error details:', error.message, error.details, error.hint); // More detailed error logging
        alert('Registration failed: ' + (error.message || 'Unknown error occurred'));
        submitBtn.disabled = false;
        submitBtn.textContent = 'Complete Registration';
    }
}
