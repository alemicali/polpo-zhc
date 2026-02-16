import '/backend/backend.dart';
import '/flutter_flow/flutter_flow_util.dart';
import 'services_list_widget.dart' show ServicesListWidget;
import 'package:flutter/material.dart';

class ServicesListModel extends FlutterFlowModel<ServicesListWidget> {
  ///  Local state fields for this component.

  List<AppointmentsRecord> appointments = [];
  void addToAppointments(AppointmentsRecord item) => appointments.add(item);
  void removeFromAppointments(AppointmentsRecord item) =>
      appointments.remove(item);
  void removeAtIndexFromAppointments(int index) => appointments.removeAt(index);
  void insertAtIndexInAppointments(int index, AppointmentsRecord item) =>
      appointments.insert(index, item);
  void updateAppointmentsAtIndex(
          int index, Function(AppointmentsRecord) updateFn) =>
      appointments[index] = updateFn(appointments[index]);

  ///  State fields for stateful widgets in this component.

  // Stores action output result for [Backend Call - Create Document] action in Icon widget.
  AppointmentsRecord? appointment1;
  // Stores action output result for [Backend Call - Create Document] action in Icon widget.
  AppointmentsRecord? appointment;
  // Stores action output result for [Backend Call - Create Document] action in Icon widget.
  SalesRecord? saleDocument;

  @override
  void initState(BuildContext context) {}

  @override
  void dispose() {}
}
