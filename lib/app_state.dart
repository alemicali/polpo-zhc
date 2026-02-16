import 'package:flutter/material.dart';
import '/backend/backend.dart';
import '/backend/schema/structs/index.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'flutter_flow/flutter_flow_util.dart';
import 'dart:convert';

class FFAppState extends ChangeNotifier {
  static FFAppState _instance = FFAppState._internal();

  factory FFAppState() {
    return _instance;
  }

  FFAppState._internal();

  static void reset() {
    _instance = FFAppState._internal();
  }

  Future initializePersistedState() async {
    prefs = await SharedPreferences.getInstance();
    _safeInit(() {
      _firstLogin = prefs.getBool('ff_firstLogin') ?? _firstLogin;
    });
    _safeInit(() {
      if (prefs.containsKey('ff_currentLocation')) {
        try {
          _currentLocation =
              jsonDecode(prefs.getString('ff_currentLocation') ?? '');
        } catch (e) {
          print("Can't decode persisted json. Error: $e.");
        }
      }
    });
    _safeInit(() {
      if (prefs.containsKey('ff_selectedAccomodation')) {
        try {
          final serializedData =
              prefs.getString('ff_selectedAccomodation') ?? '{}';
          _selectedAccomodation =
              AccommodationWorkerDataStruct.fromSerializableMap(
                  jsonDecode(serializedData));
        } catch (e) {
          print("Can't decode persisted data type. Error: $e.");
        }
      }
    });
  }

  void update(VoidCallback callback) {
    callback();
    notifyListeners();
  }

  late SharedPreferences prefs;

  bool _firstLogin = false;
  bool get firstLogin => _firstLogin;
  set firstLogin(bool value) {
    _firstLogin = value;
    prefs.setBool('ff_firstLogin', value);
  }

  dynamic _currentLocation;
  dynamic get currentLocation => _currentLocation;
  set currentLocation(dynamic value) {
    _currentLocation = value;
    prefs.setString('ff_currentLocation', jsonEncode(value));
  }

  int _currentNavIndex = 1;
  int get currentNavIndex => _currentNavIndex;
  set currentNavIndex(int value) {
    _currentNavIndex = value;
  }

  AccommodationWorkerDataStruct _selectedAccomodation =
      AccommodationWorkerDataStruct();
  AccommodationWorkerDataStruct get selectedAccomodation =>
      _selectedAccomodation;
  set selectedAccomodation(AccommodationWorkerDataStruct value) {
    _selectedAccomodation = value;
    prefs.setString('ff_selectedAccomodation', value.serialize());
  }

  void updateSelectedAccomodationStruct(
      Function(AccommodationWorkerDataStruct) updateFn) {
    updateFn(_selectedAccomodation);
    prefs.setString(
        'ff_selectedAccomodation', _selectedAccomodation.serialize());
  }
}

void _safeInit(Function() initializeField) {
  try {
    initializeField();
  } catch (_) {}
}

Future _safeInitAsync(Function() initializeField) async {
  try {
    await initializeField();
  } catch (_) {}
}
