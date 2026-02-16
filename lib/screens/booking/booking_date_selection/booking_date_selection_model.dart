import '/backend/backend.dart';
import '/components/side_nav/side_nav_bar/side_nav_bar_widget.dart';
import '/components/top_nav_bar_widget.dart';
import '/flutter_flow/flutter_flow_calendar.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/flutter_flow/form_field_controller.dart';
import '/index.dart';
import 'booking_date_selection_widget.dart' show BookingDateSelectionWidget;
import 'package:flutter/material.dart';

class BookingDateSelectionModel
    extends FlutterFlowModel<BookingDateSelectionWidget> {
  ///  Local state fields for this page.

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

  ServiceDataStruct? serviceData;
  void updateServiceDataStruct(Function(ServiceDataStruct) updateFn) {
    updateFn(serviceData ??= ServiceDataStruct());
  }

  ///  State fields for stateful widgets in this page.

  // Model for SideNavBar component.
  late SideNavBarModel sideNavBarModel;
  // Model for TopNavBar component.
  late TopNavBarModel topNavBarModel;
  // State field(s) for Calendar widget.
  DateTimeRange? calendarSelectedDay;
  // State field(s) for RadioButton widget.
  FormFieldController<String>? radioButtonValueController;
  // Stores action output result for [Backend Call - Create Document] action in Button widget.
  AppointmentsRecord? appointmentData1;
  // Stores action output result for [Backend Call - Create Document] action in Button widget.
  AppointmentsRecord? appointmentData;
  // Stores action output result for [Backend Call - Create Document] action in Button widget.
  SalesRecord? saleDoc;

  @override
  void initState(BuildContext context) {
    sideNavBarModel = createModel(context, () => SideNavBarModel());
    topNavBarModel = createModel(context, () => TopNavBarModel());
    calendarSelectedDay = DateTimeRange(
      start: DateTime.now().startOfDay,
      end: DateTime.now().endOfDay,
    );
  }

  @override
  void dispose() {
    sideNavBarModel.dispose();
    topNavBarModel.dispose();
  }

  /// Additional helper methods.
  String? get radioButtonValue => radioButtonValueController?.value;
}
