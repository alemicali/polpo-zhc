import '/components/navbar/navbar_widget.dart';
import '/components/side_nav/side_nav_bar/side_nav_bar_widget.dart';
import '/components/top_nav_bar_widget.dart';
import '/flutter_flow/flutter_flow_util.dart';
import '/index.dart';
import 'client_details_widget.dart' show ClientDetailsWidget;
import 'package:flutter/material.dart';

class ClientDetailsModel extends FlutterFlowModel<ClientDetailsWidget> {
  ///  State fields for stateful widgets in this page.

  // Model for SideNavBar component.
  late SideNavBarModel sideNavBarModel;
  // Model for TopNavBar component.
  late TopNavBarModel topNavBarModel;
  // Model for Navbar component.
  late NavbarModel navbarModel;

  @override
  void initState(BuildContext context) {
    sideNavBarModel = createModel(context, () => SideNavBarModel());
    topNavBarModel = createModel(context, () => TopNavBarModel());
    navbarModel = createModel(context, () => NavbarModel());
  }

  @override
  void dispose() {
    sideNavBarModel.dispose();
    topNavBarModel.dispose();
    navbarModel.dispose();
  }
}
