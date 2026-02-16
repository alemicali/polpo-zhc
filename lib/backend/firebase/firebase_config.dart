import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';

Future initFirebase() async {
  if (kIsWeb) {
    await Firebase.initializeApp(
        options: FirebaseOptions(
            apiKey: "AIzaSyDd0ChLUB8MkNfGjO1BRx0UGqVZWMHmXDA",
            authDomain: "bf-wellness-app.firebaseapp.com",
            projectId: "bf-wellness-app",
            storageBucket: "bf-wellness-app.appspot.com",
            messagingSenderId: "311886125634",
            appId: "1:311886125634:web:81d07b385fb82d32c0abdb"));
  } else {
    await Firebase.initializeApp();
  }
}
