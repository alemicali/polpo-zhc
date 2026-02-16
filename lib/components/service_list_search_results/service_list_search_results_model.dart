import '/backend/backend.dart';
import '/flutter_flow/flutter_flow_util.dart';
import 'service_list_search_results_widget.dart'
    show ServiceListSearchResultsWidget;
import 'package:flutter/material.dart';

class ServiceListSearchResultsModel
    extends FlutterFlowModel<ServiceListSearchResultsWidget> {
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

  @override
  void initState(BuildContext context) {}

  @override
  void dispose() {}
}
