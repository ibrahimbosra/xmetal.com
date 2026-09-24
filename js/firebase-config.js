// Firebase Configuration (compat)
// IMPORTANT: keep credentials secure in production; this file mirrors the app's expected global `firebase` compat usage.

var firebaseConfig = {
  apiKey: "AIzaSyA02oo3j3IgHRceFVoArcPB6bcRTOI4tw4",
  authDomain: "x-metal-finance.firebaseapp.com",
  projectId: "x-metal-finance",
  storageBucket: "x-metal-finance.firebasestorage.app",
  messagingSenderId: "895302522066",
  appId: "1:895302522066:web:858357b0d671a3f489490b"
};

// Initialize Firebase using compat SDK loaded from index.html
var firebaseAuthInstance = null;
var firebaseDbInstance = null;
var firebaseAuthPersistenceReady = Promise.resolve();

try {
  // `firebase` global should be provided by the compat SDK script in index.html
  if (window.firebase && window.firebase.initializeApp) {
    if (!window.__xmetalFirebaseInitialized) {
      window.firebase.initializeApp(firebaseConfig);
      window.__xmetalFirebaseInitialized = true;
    }
    firebaseAuthInstance = window.firebase.auth();
    firebaseDbInstance = window.firebase.firestore();
    if (firebaseAuthInstance && firebaseAuthInstance.setPersistence && window.firebase.auth.Auth.Persistence.LOCAL) {
      firebaseAuthPersistenceReady = firebaseAuthInstance.setPersistence(window.firebase.auth.Auth.Persistence.LOCAL).catch(function() {
        console.warn('Auth persistence not available');
      });
    }

    if (firebaseDbInstance) {
      // Prefer the modern Firestore cache API when the loaded SDK surface exposes it.
      if (firebaseDbInstance.persistentLocalCache && typeof firebaseDbInstance.persistentLocalCache === 'function') {
        try {
          firebaseDbInstance.persistentLocalCache({ tabManager: 'xmetal' });
        } catch (err) {
          console.warn('Modern persistentLocalCache configuration unavailable; falling back to compatibility settings.', err);
        }
      }

      // Compatibility fallback for the current compat SDK payload used by this project.
      if (firebaseDbInstance.enablePersistence && typeof firebaseDbInstance.enablePersistence === 'function') {
        try {
          firebaseDbInstance.enablePersistence({ synchronizeTabs: true }).catch(function() {
            console.warn('Firestore persistence not available');
          });
        } catch (err) {
          console.warn('Firestore persistence initialization failed', err);
        }
      }
    }
  } else {
    console.warn('Firebase compat SDK not loaded; please ensure the compat scripts are included in index.html');
  }
} catch (error) {
  console.error('Firebase initialization error:', error);
}

window.firebaseAuth = firebaseAuthInstance;
window.firebaseDb = firebaseDbInstance;
