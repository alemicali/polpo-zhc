import '/backend/backend.dart';
import '/components/no_workers_services_list/no_workers_services_list_widget.dart';
import '/components/packages_list/packages_list_widget.dart';
import '/components/service_list_search_results/service_list_search_results_widget.dart';
import '/components/services_list/services_list_widget.dart';
import '/components/side_nav/side_nav_bar/side_nav_bar_widget.dart';
import '/components/top_nav_bar_widget.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/index.dart';
import 'booking_service_selection_widget.dart'
    show BookingServiceSelectionWidget;
import 'package:flutter/material.dart';

class BookingServiceSelectionModel
    extends FlutterFlowModel<BookingServiceSelectionWidget> {
  ///  State fields for stateful widgets in this page.

  // Model for SideNavBar component.
  late SideNavBarModel sideNavBarModel;
  // Model for TopNavBar component.
  late TopNavBarModel topNavBarModel;
  // State field(s) for TabBar widget.
  TabController? tabBarController;
  int get tabBarCurrentIndex =>
      tabBarController != null ? tabBarController!.index : 0;
  int get tabBarPreviousIndex =>
      tabBarController != null ? tabBarController!.previousIndex : 0;

  // State field(s) for TextField widget.
  FocusNode? textFieldFocusNode;
  TextEditingController? textController;
  String? Function(BuildContext, String?)? textControllerValidator;
  // Algolia Search Results from action on TextField
  List<AccomodationServicesRecord>? algoliaSearchResults = [];
  // Model for ServicesList component.
  late ServicesListModel servicesListModel;
  // Model for ServiceListSearchResults component.
  late ServiceListSearchResultsModel serviceListSearchResultsModel;
  // Model for PackagesList component.
  late PackagesListModel packagesListModel;
  // Model for NoWorkersServicesList component.
  late NoWorkersServicesListModel noWorkersServicesListModel;

  @override
  void initState(BuildContext context) {
    sideNavBarModel = createModel(context, () => SideNavBarModel());
    topNavBarModel = createModel(context, () => TopNavBarModel());
    servicesListModel = createModel(context, () => ServicesListModel());
    serviceListSearchResultsModel =
        createModel(context, () => ServiceListSearchResultsModel());
    packagesListModel = createModel(context, () => PackagesListModel());
    noWorkersServicesListModel =
        createModel(context, () => NoWorkersServicesListModel());
  }

  @override
  void dispose() {
    sideNavBarModel.dispose();
    topNavBarModel.dispose();
    tabBarController?.dispose();
    textFieldFocusNode?.dispose();
    textController?.dispose();

    servicesListModel.dispose();
    serviceListSearchResultsModel.dispose();
    packagesListModel.dispose();
    noWorkersServicesListModel.dispose();
  }
}
