// Automatic FlutterFlow imports
import '/backend/backend.dart';
import '/backend/schema/structs/index.dart';
import '/backend/schema/enums/enums.dart';
import '/flutter_flow/flutter_flow_theme.dart';
import '/flutter_flow/flutter_flow_util.dart';
import 'index.dart'; // Imports other custom actions
import '/flutter_flow/custom_functions.dart'; // Imports custom functions
import 'package:flutter/material.dart';
// Begin custom action code
// DO NOT REMOVE OR MODIFY THE CODE ABOVE!

// Set your action name, define your arguments and return parameter,
// and then add the boilerplate code using the green button on the right!
List<DateTime> generateDayTimeSlot(
    DateTime date, int startHour, int endHour, int fraction) {
  DateTime startTime = DateTime(date.year, date.month, date.day, startHour);
  DateTime endTime = DateTime(date.year, date.month, date.day, endHour);

  List<DateTime> slots = [];

  for (DateTime current = startTime;
      current.isBefore(endTime) || current.isAtSameMomentAs(endTime);
      current = current.add(Duration(minutes: fraction))) {
    slots.add(current);
  }

  return slots;
}
