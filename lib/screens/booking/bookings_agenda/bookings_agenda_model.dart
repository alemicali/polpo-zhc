import '/backend/backend.dart';
import '/components/navbar/navbar_widget.dart';
import '/components/side_nav/side_nav_bar/side_nav_bar_widget.dart';
import '/components/top_nav_bar_widget.dart';
import '/flutter_flow/flutter_flow_calendar.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/flutter_flow/form_field_controller.dart';
import '/index.dart';
import 'bookings_agenda_widget.dart' show BookingsAgendaWidget;
import 'package:flutter/material.dart';

class BookingsAgendaModel extends FlutterFlowModel<BookingsAgendaWidget> {
  ///  State fields for stateful widgets in this page.

  // Model for SideNavBar component.
  late SideNavBarModel sideNavBarModel;
  // Model for TopNavBar component.
  late TopNavBarModel topNavBarModel;
  // State field(s) for ChoiceChips widget.
  FormFieldController<List<String>>? choiceChipsValueController;
  String? get choiceChipsValue =>
      choiceChipsValueController?.value?.firstOrNull;
  set choiceChipsValue(String? val) =>
      choiceChipsValueController?.value = val != null ? [val] : [];
  // State field(s) for Calendar widget.
  DateTimeRange? calendarSelectedDay;
  // State field(s) for View Type selection (calendar, list, timegrid)
  String viewType = 'calendar';
  // Stores action output result for [Backend Call - Read Document] action in ConditionalBuilder widget.
  WorkersRecord? workerDoc;
  // Stores action output result for [Custom Action - extractAppointmentFromJson] action in Container widget.
  AppointmentsRecord? myAppointmentRef;
  // Stores action output result for [Backend Call - Read Document] action in Container widget.
  ClientsRecord? myAppointmentClient;
  // Stores action output result for [Custom Action - extractAppointmentFromJson] action in Container widget.
  AppointmentsRecord? workerAppointmentRef;
  // Stores action output result for [Backend Call - Read Document] action in Container widget.
  ClientsRecord? workerAppointmentClient;
  // Model for Navbar component.
  late NavbarModel navbarModel;

  @override
  void initState(BuildContext context) {
    sideNavBarModel = createModel(context, () => SideNavBarModel());
    topNavBarModel = createModel(context, () => TopNavBarModel());
    calendarSelectedDay = DateTimeRange(
      start: DateTime.now().startOfDay,
      end: DateTime.now().endOfDay,
    );
    navbarModel = createModel(context, () => NavbarModel());
  }

  @override
  void dispose() {
    sideNavBarModel.dispose();
    topNavBarModel.dispose();
    navbarModel.dispose();
  }

  /// Action blocks.
  Future testActionBlock(BuildContext context) async {}
}
