import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:intl/intl.dart';
import 'package:timeago/timeago.dart' as timeago;
import 'lat_lng.dart';
import 'place.dart';
import 'uploaded_file.dart';
import '/backend/backend.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import '/backend/schema/structs/index.dart';
import '/backend/schema/enums/enums.dart';
import '/auth/firebase_auth/auth_util.dart';

String getInitialLetter(String name) {
  if (name.isEmpty) {
    return 'BF';
  }
  return name[0].toUpperCase();
}

List<DateTime> generateTimeSlotsFunc(
  DateTime date,
  int startHour,
  int endHour,
  int fraction,
) {
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

List<DateTime>? getDateBoundaries(DateTime currentDate) {
  DateTime startOfWorkday =
      DateTime(currentDate.year, currentDate.month, currentDate.day, 8, 0);
  DateTime endOfWorkday =
      DateTime(currentDate.year, currentDate.month, currentDate.day, 17, 0);

  return [startOfWorkday, endOfWorkday];
}

List<dynamic>? generateWorkerAvailableTimeSlots(
  List<AppointmentsRecord>? appointments,
  int startHour,
  int endHour,
  int fraction,
  DocumentReference? workerRef,
  DateTime date,
  int? bufferTime,
) {
  DateTime now = DateTime.now();

  DateTime _assignStartHour() {
    int _startHour = startHour;
    int _startMinute = 0;

    if (date.day == now.day && _startHour < now.hour) {
      _startHour = now.hour;
      _startMinute = now.minute;

      if (_startMinute > 0) {
        if (_startMinute < 30) {
          _startMinute = 30;
        } else {
          _startMinute = 0;
          _startHour++;
        }
      }
    }

    return DateTime(date.year, date.month, date.day, _startHour, _startMinute);
  }

  DateTime startTime = _assignStartHour();

  DateTime endTime = DateTime(date.year, date.month, date.day, endHour);

  // Questa lista conterrà gli orari degli appuntamenti esistenti
  var bookedTimes = [];

  for (var appointment in appointments!) {
    if (appointment.workers.contains(workerRef) &&
        (appointment.startDate!.isAfter(startTime) ||
            appointment.startDate!.isAtSameMomentAs(startTime)) &&
        appointment.startDate!.isBefore(endTime)) {
      bookedTimes.add({
        'startDate': appointment.startDate!,
        'duration': appointment.duration,
      });
    }
  }

  // Lista degli orari disponibili
  List<String> availableSlots = [];

  DateTime current = startTime;

  while (current.isBefore(endTime)) {
    bool isBooked = bookedTimes.any((bookedTime) =>
        bookedTime['startDate'].year == current.year &&
        bookedTime['startDate'].month == current.month &&
        bookedTime['startDate'].day == current.day &&
        bookedTime['startDate'].hour == current.hour &&
        bookedTime['startDate'].minute == current.minute);

    if (!isBooked) {
      availableSlots.add(DateFormat('HH:mm').format(current));
      current = current.add(Duration(minutes: fraction));
    } else {
      // Access the conflicting bookedTime here
      var conflictingBookedTime = bookedTimes.firstWhere((bookedTime) =>
          bookedTime['startDate'].year == current.year &&
          bookedTime['startDate'].month == current.month &&
          bookedTime['startDate'].day == current.day &&
          bookedTime['startDate'].hour == current.hour &&
          bookedTime['startDate'].minute == current.minute);

      current = conflictingBookedTime['startDate'].add(Duration(
          minutes:
              ((conflictingBookedTime["duration"] ?? 0) + (bufferTime ?? 0))));
    }
  }

  return availableSlots;
}

List<dynamic>? generateAvailableTimeSlots(
  List<AppointmentsRecord>? appointments,
  int startHour,
  int endHour,
  int fraction,
  DocumentReference? workerRef,
  DateTime date,
  int? bufferTime,
) {
  DateTime now = DateTime.now();

  DateTime _assignStartHour() {
    int _startHour = startHour;
    int _startMinute = 0;

    if (date.day == now.day && _startHour < now.hour) {
      _startHour = now.hour;
      _startMinute = now.minute;

      if (_startMinute > 0) {
        if (_startMinute < 30) {
          _startMinute = 30;
        } else {
          _startMinute = 0;
          _startHour++;
        }
      }
    }

    return DateTime(date.year, date.month, date.day, _startHour, _startMinute);
  }

  DateTime startTime = DateTime(date.year, date.month, date.day, startHour);
  DateTime endTime = DateTime(date.year, date.month, date.day, endHour);

  String formatTime(DateTime datetime) {
    String twoDigit(int n) => n.toString().padLeft(2, '0');
    return "${twoDigit(datetime.hour)}:${twoDigit(datetime.minute)}";
  }

  List<Map<String, dynamic>> slotsWithAppointments = [];
  for (var appointment in appointments!) {
    if (appointment.workers.contains(workerRef) &&
        appointment.startDate!.isAfter(startTime) &&
        appointment.startDate!.isBefore(endTime)) {
      var appointmentStartDate = appointment.startDate;
      slotsWithAppointments.add({
        'startDate': appointment.startDate,
        'duration': appointment.duration,
        'formattedTime': DateFormat('HH:mm').format(appointmentStartDate!),
        'available': false,
        'documentRef': appointment
      });
    }
  }

  startTime = _assignStartHour();
  // Generazione degli slot temporali
  DateTime current = startTime;

  if (date.day >= now.day)
    while (current.isBefore(endTime)) {
      bool slotFound = false;
      var conflictingSlot;

      for (var slot in slotsWithAppointments) {
        if (slot['startDate'].year == current.year &&
            slot['startDate'].month == current.month &&
            slot['startDate'].day == current.day &&
            slot['startDate'].hour == current.hour &&
            slot['startDate'].minute == current.minute) {
          slotFound = true;
          conflictingSlot = slot;
          break;
        }
      }

      if (!slotFound) {
        slotsWithAppointments.add({
          'startDate': current,
          'formattedTime': DateFormat('HH:mm').format(current),
          'available': true
        });
        current = current.add(Duration(minutes: fraction));
      } else {
        current = conflictingSlot['startDate'].add(
          Duration(
            minutes: (conflictingSlot["duration"] ?? 0) + (bufferTime ?? 10),
          ),
        );
      }
    }

  // Ordina gli slot per datetime crescente
  slotsWithAppointments.sort((a, b) {
    return a['startDate'].compareTo(b['startDate']);
  });

  return slotsWithAppointments;
}

DateTime combineDateTimeAndTimeString(
  DateTime date,
  String timeString,
) {
  List<String> timeParts = timeString.split(':');
  int hour = int.parse(timeParts[0]);
  int minute = int.parse(timeParts[1]);

  return DateTime(date.year, date.month, date.day, hour, minute);
}

DateTime startOfDay(DateTime datetime) {
  return DateTime(datetime.year, datetime.month, datetime.day);
}

DateTime endOfDay(DateTime datetime) {
  return DateTime(datetime.year, datetime.month, datetime.day, 23, 59, 59);
}

List<dynamic>? generateServiceCategoryTimeSlots(
  List<AppointmentsRecord>? appointments,
  int startHour,
  int endHour,
  int fraction,
  DateTime date,
  int? bufferTime,
  String? serviceCategory,
) {
  DateTime now = DateTime.now();

  DateTime _assignStartHour() {
    int _startHour = startHour;
    int _startMinute = 0;

    if (date.day == now.day && _startHour < now.hour) {
      _startHour = now.hour;
      _startMinute = now.minute;

      if (_startMinute > 0) {
        if (_startMinute < 30) {
          _startMinute = 30;
        } else {
          _startMinute = 0;
          _startHour++;
        }
      }
    }

    return DateTime(date.year, date.month, date.day, _startHour, _startMinute);
  }

  DateTime startTime = DateTime(date.year, date.month, date.day, startHour);
  DateTime endTime = DateTime(date.year, date.month, date.day, endHour);

  String formatTime(DateTime datetime) {
    String twoDigit(int n) => n.toString().padLeft(2, '0');
    return "${twoDigit(datetime.hour)}:${twoDigit(datetime.minute)}";
  }

  List<Map<String, dynamic>> slotsWithAppointments = [];
  for (var appointment in appointments!) {
    if (serviceCategory == appointment.serviceData?.categoryName &&
        (appointment.startDate!.isAtSameMomentAs(startTime) ||
            appointment.startDate!.isAfter(startTime)) &&
        appointment.startDate!.isBefore(endTime)) {
      var appointmentStartDate = appointment.startDate;
      slotsWithAppointments.add({
        'startDate': appointment.startDate,
        'duration': appointment.duration,
        'formattedTime': DateFormat('HH:mm').format(appointmentStartDate!),
        'available': false,
        'documentRef': appointment,
        'appointmentCount': 1
      });
    }
  }

  startTime = _assignStartHour();
  // Generazione degli slot temporali
  DateTime current = startTime;

  if (date.day >= now.day)
    while (current.isBefore(endTime)) {
      bool slotFound = false;
      var conflictingSlot;

      for (var slot in slotsWithAppointments) {
        if (slot['startDate'].year == current.year &&
            slot['startDate'].month == current.month &&
            slot['startDate'].day == current.day &&
            slot['startDate'].hour == current.hour &&
            slot['startDate'].minute == current.minute) {
          slotFound = true;
          conflictingSlot = slot;
          break;
        }
      }

      if (!slotFound) {
        slotsWithAppointments.add({
          'startDate': current,
          'formattedTime': DateFormat('HH:mm').format(current),
          'available': true
        });
        current = current.add(Duration(minutes: fraction));
      } else {
        current = current.add(Duration(minutes: fraction));
        // current = conflictingSlot['startDate'].add(
        //   Duration(
        //     minutes: (conflictingSlot["duration"] ?? 0) + (bufferTime ?? 10),
        //   ),
        // );
      }
    }

  // Ordina gli slot per datetime crescente
  slotsWithAppointments.sort((a, b) {
    return a['startDate'].compareTo(b['startDate']);
  });

  Map<String, Map<String, dynamic>> groupedSlots = {};

  for (var slot in slotsWithAppointments) {
    String startDateKey = slot['startDate'].toString();
    if (groupedSlots.containsKey(startDateKey)) {
      groupedSlots[startDateKey]!['appointmentCount']++;
    } else {
      groupedSlots[startDateKey] = {
        'startDate': slot['startDate'],
        'formattedTime': DateFormat('HH:mm').format(slot['startDate']),
        'available': slot['available'],
        'appointmentCount': slot['available'] == true ? 0 : 1,
      };
    }
  }

  // Convert the Map back to a List
  List<Map<String, dynamic>> result = groupedSlots.values.toList();

  return result;
}

double appointmentsTotalPrice(List<AppointmentsRecord>? appointments) {
  double total = 0;

  if (appointments != null) {
    for (var appointment in appointments) {
      // Assumi che price siano definiti e non nulli
      double price = appointment.price ?? 0;
      total += price;
    }
  }

  return total;
}

double clientsTotalToPay(List<ClientsRecord>? clients) {
  double total = 0;

  if (clients != null) {
    for (var clientRecord in clients) {
      // Assumo che ogni ClientsRecord abbia una proprietà toPay
      total += clientRecord.toPay ??
          0; // Aggiunge toPay al totale, assumendo 0 per valori null
    }
  }

  return total;
}

List<AppointmentDataStruct>? createAppointmentsData(
    List<AppointmentsRecord>? appointments) {
  if (appointments == null) {
    return null;
  }

  return appointments.map((appointment) {
    return AppointmentDataStruct(
      date: appointment.startDate,
      appointmentRef: appointment.reference,
    );
  }).toList();
}

String formatDate(DateTime? time) {
  return time != null ? DateFormat('yMMMd').format(time).toString() : '';
}

DateTime graceTime() {
  return DateTime.now().subtract(Duration(minutes: 30));
}

List<AccomodationWorkersRecord> filterAccommodationsByEndDates(
    List<AccomodationWorkersRecord> accommodations) {
  List<AccomodationWorkersRecord> filteredList = [];

  for (AccomodationWorkersRecord accommodation in accommodations) {
    if (accommodation.endDate!.isAfter(DateTime.now())) {
      filteredList.add(accommodation);
    }
  }

  return filteredList;
}
