// Firebase configuration and initialization
const firebaseConfig = window.PROMPTER_FIREBASE_CONFIG || {
    apiKey: "AIzaSyApTqHf1EU2LEwbkM_a30jAdyU7DjE4LIY",
    authDomain: "storyteller-ce8c2.firebaseapp.com",
    projectId: "storyteller-ce8c2",
    storageBucket: "storyteller-ce8c2.firebasestorage.app",
    messagingSenderId: "111944438783",
    appId: "1:111944438783:web:dfe4f5843e75fac0da4dca",
    measurementId: "G-2E8J26KE5Z"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize Firestore only on pages that loaded the Firestore compat SDK.
const db = typeof firebase.firestore === 'function' ? firebase.firestore() : null;

// Initialize Firebase Auth
const auth = firebase.auth();

// Make auth and db available globally for other scripts
window.auth = auth;
window.db = db;



// Debug Firebase initialization
console.log('Firebase Initialization Debug:', {
    app: firebase.app().name,
    authDomain: firebaseConfig.authDomain,
    projectId: firebaseConfig.projectId,
    currentURL: window.location.href,
    protocol: window.location.protocol,
    isSecure: window.location.protocol === 'https:',
    authReady: !!auth,
    dbReady: !!db
});

// Check for mixed content
if (window.location.protocol === 'https:') {
    console.log('Running on HTTPS - checking for mixed content issues...');
    const scripts = document.getElementsByTagName('script');
    for (let script of scripts) {
        if (script.src && !script.src.startsWith('https:') && !script.src.startsWith('//')) {
            console.warn('Potential mixed content issue with script:', script.src);
        }
    }
}

// Test Firebase connectivity with error handling
auth.onAuthStateChanged(function(user) {
    console.log('Firebase Auth State Changed:', user ? 'User logged in' : 'User not logged in');
}, function(error) {
    console.error('Firebase Auth Error:', error);
});

// Test Firestore connectivity with a collection that exists
setTimeout(() => {
    if (db && firebase.auth().currentUser) {
        // Test with interviews collection which allows reads
        db.collection('interviews').limit(1).get()
            .then(() => console.log('Firestore connectivity test: SUCCESS'))
            .catch(err => console.error('Firestore connectivity test FAILED:', err));
    } else if (!db) {
        console.log('Firestore connectivity test skipped - Firestore SDK not loaded on this page');
    } else if (!firebase.auth().currentUser) {
        console.log('Firestore connectivity test skipped - no authenticated user');
    }
}, 2000); 
