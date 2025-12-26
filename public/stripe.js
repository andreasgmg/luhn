// public/stripe.js
let stripe;

// Initialize Stripe.js with the publishable key
fetch("/api/stripe-config")
    .then((result) => result.json())
    .then((data) => {
        stripe = Stripe(data.publishableKey);
    });

async function redirectToCheckout(priceId) {
    // Check if user is logged in using the Pocketbase auth store from auth.js
    if (!pb || !pb.authStore.isValid) {
        // If not logged in, redirect to login page
        alert("Du måste logga in för att kunna starta en prenumeration.");
        window.location.href = '/login.html';
        return;
    }

    const userId = pb.authStore.model.id;

    try {
        // Create a checkout session on the server
        const response = await fetch('/api/create-checkout-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ priceId, userId }),
        });

        const session = await response.json();

        if (session.url) {
            // Redirect to Stripe Checkout
            window.location.href = session.url;
        } else {
            alert('Kunde inte starta en betalningssession. Försök igen.');
            console.error('Error creating checkout session:', session);
        }
    } catch (error) {
        alert('Ett fel uppstod. Försök igen.');
        console.error('Error:', error);
    }
}
