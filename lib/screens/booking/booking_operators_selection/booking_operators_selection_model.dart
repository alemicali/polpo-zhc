import '/backend/backend.dart';
import '/components/side_nav/side_nav_bar/side_nav_bar_widget.dart';
import '/components/top_nav_bar_widget.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/index.dart';
import 'booking_operators_selection_widget.dart'
    show BookingOperatorsSelectionWidget;
import 'package:flutter/material.dart';
import 'package:infinite_scroll_pagination/infinite_scroll_pagination.dart';

class BookingOperatorsSelectionModel
    extends FlutterFlowModel<BookingOperatorsSelectionWidget> {
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
  // State field(s) for ListView widget.

  PagingController<DocumentSnapshot?, WorkersRecord>? listViewPagingController;
  Query? listViewPagingQuery;
  List<StreamSubscription?> listViewStreamSubscriptions = [];

  @override
  void initState(BuildContext context) {
    sideNavBarModel = createModel(context, () => SideNavBarModel());
    topNavBarModel = createModel(context, () => TopNavBarModel());
  }

  @override
  void dispose() {
    sideNavBarModel.dispose();
    topNavBarModel.dispose();
    listViewStreamSubscriptions.forEach((s) => s?.cancel());
    listViewPagingController?.dispose();
  }

  /// Additional helper methods.
  PagingController<DocumentSnapshot?, WorkersRecord> setListViewController(
    Query query, {
    DocumentReference<Object?>? parent,
  }) {
    listViewPagingController ??= _createListViewController(query, parent);
    if (listViewPagingQuery != query) {
      listViewPagingQuery = query;
      listViewPagingController?.refresh();
    }
    return listViewPagingController!;
  }

  PagingController<DocumentSnapshot?, WorkersRecord> _createListViewController(
    Query query,
    DocumentReference<Object?>? parent,
  ) {
    final controller =
        PagingController<DocumentSnapshot?, WorkersRecord>(firstPageKey: null);
    return controller
      ..addPageRequestListener(
        (nextPageMarker) => queryWorkersRecordPage(
          queryBuilder: (_) => listViewPagingQuery ??= query,
          nextPageMarker: nextPageMarker,
          streamSubscriptions: listViewStreamSubscriptions,
          controller: controller,
          pageSize: 25,
          isStream: true,
        ),
      );
  }
}
