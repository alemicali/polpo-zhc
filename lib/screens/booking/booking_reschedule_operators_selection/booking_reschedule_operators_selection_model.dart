import '/backend/backend.dart';
import '/components/side_nav/side_nav_bar/side_nav_bar_widget.dart';
import '/components/top_nav_bar_widget.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/index.dart';
import 'booking_reschedule_operators_selection_widget.dart'
    show BookingRescheduleOperatorsSelectionWidget;
import 'package:flutter/material.dart';

class BookingRescheduleOperatorsSelectionModel
    extends FlutterFlowModel<BookingRescheduleOperatorsSelectionWidget> {
  ///  Local state fields for this page.

  List<WorkersRecord> bookingEmployees = [];
  void addToBookingEmployees(WorkersRecord item) => bookingEmployees.add(item);
  void removeFromBookingEmployees(WorkersRecord item) =>
      bookingEmployees.remove(item);
  void removeAtIndexFromBookingEmployees(int index) =>
      bookingEmployees.removeAt(index);
  void insertAtIndexInBookingEmployees(int index, WorkersRecord item) =>
      bookingEmployees.insert(index, item);
  void updateBookingEmployeesAtIndex(
          int index, Function(WorkersRecord) updateFn) =>
      bookingEmployees[index] = updateFn(bookingEmployees[index]);

  WorkersRecord? worker;

  bool autoEmployees = false;

  ///  State fields for stateful widgets in this page.

  // Model for SideNavBar component.
  late SideNavBarModel sideNavBarModel;
  // Model for TopNavBar component.
  late TopNavBarModel topNavBarModel;

  @override
  void initState(BuildContext context) {
    sideNavBarModel = createModel(context, () => SideNavBarModel());
    topNavBarModel = createModel(context, () => TopNavBarModel());
  }

  @override
  void dispose() {
    sideNavBarModel.dispose();
    topNavBarModel.dispose();
  }
}
